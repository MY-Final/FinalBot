import type { ToolDefinition } from "@finalbot/core";
import type { FinalBotDatabase, McpServerRecord } from "@finalbot/db";

interface JsonRpcResponse {
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface McpSession {
  request(method: string, params?: unknown): Promise<unknown>;
  notify?(method: string, params?: unknown): Promise<void>;
  close(): Promise<void>;
  protocolVersion: string;
}

export interface McpManagerOptions {
  db: FinalBotDatabase;
  requestTimeoutMs?: number;
}

export class McpManager {
  private readonly sessions = new Map<string, McpSession>();
  private readonly tools = new Map<string, ToolDefinition[]>();
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: McpManagerOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  async reload(): Promise<ToolDefinition[]> {
    await this.close();
    const discovered: ToolDefinition[] = [];
    for (const server of this.options.db.listMcpServers()) {
      try {
        const session = await this.connect(server);
        this.sessions.set(server.id, session);
        const tools = await this.discover(server, session);
        this.tools.set(server.id, tools);
        discovered.push(...tools);
        this.options.db.updateMcpServerStatus(server.id, "connected", null);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.options.db.updateMcpServerStatus(server.id, "error", message);
      }
    }
    return discovered;
  }

  async close(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.tools.clear();
    await Promise.all(sessions.map((session) => session.close().catch(() => undefined)));
  }

  listTools(serverId?: string): ToolDefinition[] {
    if (serverId) return [...(this.tools.get(serverId) ?? [])];
    return [...this.tools.values()].flat();
  }

  updateToolPolicy(serverId: string, toolName: string, policy: "auto" | "ask" | "deny"): void {
    const server = this.options.db.getMcpServer(serverId);
    if (!server) throw new Error(`MCP server not found: ${serverId}`);
    const tools = this.tools.get(serverId);
    if (!tools?.some((tool) => tool.name === toolName)) {
      throw new Error(`MCP tool not found: ${serverId}/${toolName}`);
    }
    this.options.db.setMcpToolPolicy(serverId, toolName, policy);
    const updated = tools.map((tool) => (tool.name === toolName ? { ...tool, policy } : tool));
    this.tools.set(serverId, updated);
  }

  async removeServer(serverId: string): Promise<boolean> {
    const session = this.sessions.get(serverId);
    this.sessions.delete(serverId);
    this.tools.delete(serverId);
    if (session) await session.close().catch(() => undefined);
    return this.options.db.deleteMcpServer(serverId);
  }

  private async connect(server: McpServerRecord): Promise<McpSession> {
    if (server.transport === "stdio") return this.connectStdio(server);
    return this.connectHttp(server);
  }

  private async connectStdio(server: McpServerRecord): Promise<McpSession> {
    if (!server.command) throw new Error(`MCP server ${server.id} has no command`);
    const args = JSON.parse(server.argsJson) as string[];
    const envRefs = JSON.parse(server.envRefsJson) as Record<string, string>;
    const env: Record<string, string> = {};
    for (const [target, source] of Object.entries(envRefs)) {
      const value = process.env[source];
      if (value !== undefined) env[target] = value;
    }
    const child = Bun.spawn([server.command, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...processEnv(), ...env },
    });
    const stdin = child.stdin as {
      write(data: string): unknown;
      flush(): unknown;
    };
    const reader = child.stdout.getReader();
    void consumeStream(child.stderr);
    const decoder = new TextDecoder();
    const pending = new Map<
      number,
      {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    let nextId = 1;
    let buffer = "";
    let closed = false;
    void (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          while (true) {
            const newline = buffer.indexOf("\n");
            if (newline < 0) break;
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line) settleLine(line, pending);
          }
        }
      } finally {
        closed = true;
        for (const item of pending.values()) item.reject(new Error("MCP stdio closed"));
        pending.clear();
      }
    })();

    const session: McpSession = {
      protocolVersion: "2025-06-18",
      request: (method, params) => {
        if (closed) return Promise.reject(new Error("MCP stdio closed"));
        const id = nextId++;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`MCP request timed out: ${method}`));
          }, this.requestTimeoutMs);
          pending.set(id, { resolve, reject, timer });
          stdin.write(
            `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`,
          );
          void stdin.flush();
        });
      },
      notify: async (method, params) => {
        if (closed) throw new Error("MCP stdio closed");
        stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) })}\n`,
        );
        void stdin.flush();
      },
      close: async () => {
        closed = true;
        child.kill();
        await child.exited.catch(() => undefined);
      },
    };
    await this.initialize(session);
    return session;
  }

  private async connectHttp(server: McpServerRecord): Promise<McpSession> {
    if (!server.url) throw new Error(`MCP server ${server.id} has no url`);
    const headers = resolveHeaders(JSON.parse(server.headersJson) as Record<string, string>);
    let nextId = 1;
    let sessionId: string | null = null;
    let protocolVersion = "2025-06-18";
    const post = async (body: Record<string, unknown>): Promise<Response> => {
      const response = await fetch(server.url as string, {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          ...headers,
          ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
          ...(body.method === "initialize" ? {} : { "MCP-Protocol-Version": protocolVersion }),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      const assigned = response.headers.get("Mcp-Session-Id");
      if (assigned) sessionId = assigned;
      if (!response.ok) {
        throw new Error(`MCP HTTP failed: ${response.status} ${await response.text()}`);
      }
      return response;
    };
    const readResponse = async (response: Response): Promise<unknown> => {
      const contentType = response.headers.get("Content-Type") ?? "";
      if (contentType.includes("text/event-stream")) {
        const text = await response.text();
        const data = text
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .at(-1);
        if (!data) throw new Error("MCP HTTP returned an empty event stream");
        return parseRpcResult(JSON.parse(data) as JsonRpcResponse);
      }
      return parseRpcResult((await response.json()) as JsonRpcResponse);
    };
    const request = async (method: string, params?: unknown): Promise<unknown> => {
      const response = await post({
        jsonrpc: "2.0",
        id: nextId++,
        method,
        ...(params === undefined ? {} : { params }),
      });
      return readResponse(response);
    };
    const session: McpSession = {
      get protocolVersion() {
        return protocolVersion;
      },
      request,
      notify: async (method, params) => {
        await post({
          jsonrpc: "2.0",
          method,
          ...(params === undefined ? {} : { params }),
        });
      },
      close: async () => undefined,
    };
    const initialized = (await this.initialize(session)) as {
      protocolVersion?: string;
    } | null;
    protocolVersion = initialized?.protocolVersion ?? protocolVersion;
    return session;
  }

  private async initialize(session: McpSession): Promise<unknown> {
    const result = await session.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "finalbot", version: "0.1.0" },
    });
    await session.notify?.("notifications/initialized").catch(() => undefined);
    return result;
  }

  private async discover(server: McpServerRecord, session: McpSession): Promise<ToolDefinition[]> {
    const result = (await session.request("tools/list", {})) as { tools?: McpTool[] };
    return (result.tools ?? []).map((tool) => ({
      namespace: `mcp.${server.id}`,
      name: tool.name,
      description: tool.description ?? tool.name,
      inputSchema: tool.inputSchema ?? { type: "object", additionalProperties: true },
      policy: this.options.db.getMcpToolPolicy(server.id, tool.name),
      execute: async (input: unknown) => {
        const current = this.sessions.get(server.id);
        if (!current) {
          this.options.db.updateMcpServerStatus(
            server.id,
            "disconnected",
            `MCP server is disconnected: ${server.id}`,
          );
          throw new Error(`MCP server is disconnected: ${server.id}`);
        }
        try {
          const result = await current.request("tools/call", {
            name: tool.name,
            arguments: input,
          });
          this.options.db.updateMcpServerStatus(server.id, "connected", null);
          return result;
        } catch (error) {
          this.options.db.updateMcpServerStatus(server.id, "error", errorMessage(error));
          throw error;
        }
      },
    }));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function settleLine(
  line: string,
  pending: Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >,
): void {
  let message: JsonRpcResponse;
  try {
    message = JSON.parse(line) as JsonRpcResponse;
  } catch {
    return;
  }
  if (typeof message.id !== "number") return;
  const item = pending.get(message.id);
  if (!item) return;
  pending.delete(message.id);
  clearTimeout(item.timer);
  try {
    item.resolve(parseRpcResult(message));
  } catch (error) {
    item.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

function parseRpcResult(message: JsonRpcResponse): unknown {
  if (message.error) throw new Error(message.error.message);
  return message.result;
}

function resolveHeaders(refs: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, source] of Object.entries(refs)) {
    const value = process.env[source];
    if (value !== undefined) headers[name] = value;
  }
  return headers;
}

function processEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

async function consumeStream(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  try {
    while (!(await reader.read()).done) {
      // Drain child output so a noisy MCP server cannot block on its pipe.
    }
  } catch {
    // The child may exit while stderr is being drained.
  }
}
