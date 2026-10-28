import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FinalBotDatabase } from "@finalbot/db";
import { McpManager } from "./index";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("MCP client", () => {
  test("uses a Streamable HTTP session and discovers callable tools", async () => {
    let sessionId = "";
    let protocolVersion = "";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const message = (await request.json()) as {
          id?: number;
          method?: string;
          params?: { name?: string };
        };
        if (message.method === "initialize") {
          sessionId = "session-test";
          return Response.json(
            {
              jsonrpc: "2.0",
              id: message.id,
              result: { protocolVersion: "2025-06-18", capabilities: {} },
            },
            { headers: { "Mcp-Session-Id": sessionId } },
          );
        }
        expect(request.headers.get("Mcp-Session-Id")).toBe(sessionId);
        protocolVersion = request.headers.get("MCP-Protocol-Version") ?? "";
        if (message.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        if (message.method === "tools/list") {
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              tools: [
                {
                  name: "echo",
                  description: "Echo text",
                  inputSchema: {
                    type: "object",
                    properties: { text: { type: "string" } },
                  },
                },
              ],
            },
          });
        }
        if (message.method === "tools/call") {
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            result: { content: [{ type: "text", text: "echoed" }] },
          });
        }
        return Response.json(
          { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown" } },
          { status: 200 },
        );
      },
    });
    cleanups.push(() => server.stop(true));
    const db = await createDb();
    cleanups.push(() => db.close());
    db.upsertMcpServer({
      id: "demo",
      name: "Demo",
      transport: "http",
      url: `http://127.0.0.1:${server.port}/mcp`,
    });
    const manager = new McpManager({ db, requestTimeoutMs: 1_000 });
    cleanups.push(() => manager.close());

    const discovered = await manager.reload();

    expect(discovered).toHaveLength(1);
    expect(manager.listTools("demo")[0]).toMatchObject({
      namespace: "mcp.demo",
      name: "echo",
      policy: "ask",
    });
    await expect(
      manager.listTools()[0]?.execute({ text: "hello" }, toolContext()),
    ).resolves.toMatchObject({ content: [{ text: "echoed" }] });
    expect(protocolVersion).toBe("2025-06-18");
    expect(db.getMcpServer("demo")?.status).toBe("connected");
  });

  test("discovers and calls a local stdio MCP server", async () => {
    const dir = await mkdtemp(join(tmpdir(), "finalbot-mcp-stdio-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const script = join(dir, "server.ts");
    await writeFile(
      script,
      `
        import { createInterface } from "node:readline";
        const rl = createInterface({ input: process.stdin });
        rl.on("line", (line) => {
          const message = JSON.parse(line);
          if (message.id === undefined) return;
          let result = {};
          if (message.method === "initialize") {
            result = { protocolVersion: "2025-06-18", capabilities: {} };
          } else if (message.method === "tools/list") {
            result = { tools: [{ name: "ping", inputSchema: { type: "object" } }] };
          } else if (message.method === "tools/call") {
            result = { content: [{ type: "text", text: "pong" }] };
          }
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
        });
      `,
    );
    const db = await createDb();
    cleanups.push(() => db.close());
    db.upsertMcpServer({
      id: "stdio",
      name: "Stdio",
      transport: "stdio",
      command: process.execPath,
      args: [script],
    });
    const manager = new McpManager({ db, requestTimeoutMs: 2_000 });
    cleanups.push(() => manager.close());

    expect(await manager.reload()).toHaveLength(1);
    const tool = manager.listTools()[0];
    if (!tool) throw new Error("stdio MCP tool was not discovered");
    expect(await tool.execute({}, toolContext())).toMatchObject({
      content: [{ text: "pong" }],
    });
  });

  test("records authentication and timeout failures without exposing credentials", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        return new Response("denied", { status: 401 });
      },
    });
    cleanups.push(() => server.stop(true));
    const db = await createDb();
    cleanups.push(() => db.close());
    db.upsertMcpServer({
      id: "private",
      name: "Private",
      transport: "http",
      url: `http://127.0.0.1:${server.port}/mcp`,
      headers: { Authorization: "MCP_TEST_AUTH" },
    });
    const manager = new McpManager({ db, requestTimeoutMs: 100 });
    cleanups.push(() => manager.close());

    expect(await manager.reload()).toEqual([]);
    expect(db.getMcpServer("private")).toMatchObject({
      status: "error",
      lastError: expect.stringContaining("401"),
    });
    expect(db.getMcpServer("private")?.headersJson).toBe(
      JSON.stringify({ Authorization: "MCP_TEST_AUTH" }),
    );
  });
});

async function createDb(): Promise<FinalBotDatabase> {
  const dir = await mkdtemp(join(tmpdir(), "finalbot-mcp-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return new FinalBotDatabase(join(dir, "test.sqlite"));
}

function toolContext() {
  return {
    runId: "run-test",
    conversationId: "conversation-test",
    botId: "coder",
    ownerId: "owner",
  };
}
