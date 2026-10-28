import { createHash } from "node:crypto";
import {
  type AgentAdapter,
  type AgentEvent,
  type AgentRunHandle,
  type AgentRunInput,
  type AgentRunResult,
  type AgentSink,
  type ApprovalDecision,
  createId,
  type DynamicToolResult,
  type DynamicToolSpec,
} from "@finalbot/core";
import type {
  CodexCommandApprovalDecision,
  CodexFileChangeApprovalDecision,
  CodexIncoming,
  CodexThreadResumeResult,
  CodexThreadStartResult,
  CodexTurnStartResult,
  JsonRpcRequest,
} from "./protocol";

export interface CodexAdapterConfig {
  executable?: string;
  model?: string;
  clientVersion?: string;
  codexHome?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ProcessInput {
  write(data: string): unknown;
  flush(): unknown;
}

interface ActiveRun {
  nativeThreadId: string | null;
  nativeTurnId: string | null;
  output: string;
  sink: AgentSink;
  dynamicToolRoutes: CodexDynamicToolRoutes | null;
  resolve: (result: AgentRunResult) => void;
  reject: (error: Error) => void;
  finished: boolean;
  structuredOutput?: unknown;
}

export interface CodexDynamicToolNamespace {
  type: "namespace";
  name: string;
  description: string;
  tools: DynamicToolSpec[];
}

export type CodexDynamicTool = DynamicToolSpec | CodexDynamicToolNamespace;

export interface CodexDynamicToolNamespaceRoute {
  namespace: string;
  tools: Map<string, string>;
}

export interface CodexDynamicToolRoutes {
  flatTools: Map<string, string>;
  namespaces: Map<string, CodexDynamicToolNamespaceRoute>;
}

export interface CompiledCodexDynamicTools {
  tools: CodexDynamicTool[];
  routes: CodexDynamicToolRoutes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class CodexAppServerClient {
  private process: ReturnType<typeof Bun.spawn> | null = null;
  private requestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly activeRuns = new Map<string, ActiveRun>();
  private initialized = false;
  private connecting: Promise<void> | null = null;
  private stdoutReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private stderrReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private stderrTail = "";

  constructor(private readonly config: CodexAdapterConfig = {}) {}

  private async ensureStarted(): Promise<void> {
    if (this.initialized && this.process) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.startProcess().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async startProcess(): Promise<void> {
    const executable = this.config.executable ?? "codex";
    const process = Bun.spawn([executable, "app-server", "--listen", "stdio://"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...processEnv(),
        ...(this.config.codexHome ? { CODEX_HOME: this.config.codexHome } : {}),
      },
    });
    this.process = process;
    this.stdoutReader = process.stdout.getReader();
    this.stderrReader = process.stderr.getReader();
    void this.readStdout();
    void this.readStderr();
    void process.exited.then((code) => {
      this.handleExit(code);
    });

    await this.request("initialize", {
      clientInfo: {
        name: "finalbot",
        title: "FinalBot",
        version: this.config.clientVersion ?? "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.notify("initialized", {});
    this.initialized = true;
  }

  private async readStdout(): Promise<void> {
    const reader = this.stdoutReader;
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = "";
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
          if (!line) continue;
          this.handleLine(line);
        }
      }
    } catch (error) {
      if (this.process) this.failAll(new Error(`Codex stdout failed: ${errorMessage(error)}`));
    }
  }

  private async readStderr(): Promise<void> {
    const reader = this.stderrReader;
    if (!reader) return;
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        this.stderrTail = `${this.stderrTail}${text}`.slice(-4000);
      }
    } catch {
      // stderr is telemetry only
    }
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(message)) return;
    const incoming = message as unknown as CodexIncoming;

    if (typeof incoming.id === "number" && "result" in incoming) {
      const pending = this.pending.get(incoming.id);
      if (pending) {
        this.pending.delete(incoming.id);
        clearTimeout(pending.timer);
        pending.resolve(incoming.result);
      }
      return;
    }
    if (typeof incoming.id === "number" && "error" in incoming) {
      const pending = this.pending.get(incoming.id);
      if (pending) {
        this.pending.delete(incoming.id);
        clearTimeout(pending.timer);
        const error = incoming.error;
        pending.reject(
          new Error(isRecord(error) ? String(error.message ?? "RPC failed") : "RPC failed"),
        );
      }
      return;
    }
    if (typeof incoming.method !== "string") return;

    if (incoming.id !== undefined) {
      void this.handleServerRequest(incoming.method, incoming.id, incoming.params);
    } else {
      this.handleNotification(incoming.method, incoming.params);
    }
  }

  private async handleNotification(method: string, params: unknown): Promise<void> {
    if (!isRecord(params)) return;
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    const turnId = typeof params.turnId === "string" ? params.turnId : null;
    const run = threadId ? this.findRun(threadId, turnId) : this.findRunByTurn(turnId);
    if (!run) return;

    if (method === "item/agentMessage/delta") {
      const delta = typeof params.delta === "string" ? params.delta : "";
      if (!delta) return;
      run.output += delta;
      await run.sink.event({ type: "delta", text: delta });
      return;
    }
    if (method === "turn/started") {
      const turn = isRecord(params.turn) ? params.turn : null;
      if (turn && typeof turn.id === "string") run.nativeTurnId = turn.id;
      return;
    }
    if (method === "error") {
      const error = isRecord(params.error) ? params.error : null;
      const message = error && typeof error.message === "string" ? error.message : "Codex error";
      await run.sink.event({ type: "warning", message });
      return;
    }
    if (method === "turn/completed") {
      const turn = isRecord(params.turn) ? params.turn : null;
      const status = turn && typeof turn.status === "string" ? turn.status : "failed";
      const error =
        turn && isRecord(turn.error) && typeof turn.error.message === "string"
          ? turn.error.message
          : undefined;
      const structuredOutput = extractStructuredOutput(turn, params);
      if (structuredOutput !== undefined) run.structuredOutput = structuredOutput;
      this.settleRun(run, status, error);
      return;
    }
  }

  private async handleServerRequest(
    method: string,
    id: number | string,
    params: unknown,
  ): Promise<void> {
    if (!isRecord(params)) {
      this.respond(id, { decision: "cancel" });
      return;
    }
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    const turnId = typeof params.turnId === "string" ? params.turnId : null;
    const run = threadId ? this.findRun(threadId, turnId) : this.findRunByTurn(turnId);
    if (!run) {
      this.respond(id, { decision: "cancel" });
      return;
    }

    if (method === "item/commandExecution/requestApproval") {
      const decision = await run.sink.requestApproval({
        requestId: String(id),
        kind: "command",
        title: "Approve command",
        detail:
          typeof params.command === "string"
            ? params.command
            : typeof params.reason === "string"
              ? params.reason
              : "Codex requested command execution approval.",
        canAcceptForSession: true,
        payload: params,
      });
      this.respond(id, {
        decision: toCommandDecision(decision),
      });
      return;
    }

    if (method === "item/fileChange/requestApproval") {
      const decision = await run.sink.requestApproval({
        requestId: String(id),
        kind: "file_change",
        title: "Approve file changes",
        detail:
          typeof params.reason === "string"
            ? params.reason
            : "Codex requested approval to change files.",
        canAcceptForSession: true,
        payload: params,
      });
      this.respond(id, {
        decision: toFileDecision(decision),
      });
      return;
    }

    if (method === "item/tool/requestUserInput") {
      const questions = Array.isArray(params.questions) ? params.questions : [];
      const first = isRecord(questions[0]) ? questions[0] : null;
      const question =
        first && typeof first.question === "string" ? first.question : "Codex needs input.";
      const decision = await run.sink.requestApproval({
        requestId: String(id),
        kind: "user_input",
        title: "Input required",
        detail: question,
        canAcceptForSession: false,
        payload: params,
      });
      if (decision.action === "cancel" || decision.action === "decline") {
        this.respond(id, { answers: {} });
      } else {
        this.respond(id, { answers: {} });
      }
      return;
    }

    if (method === "item/tool/call") {
      const result = await this.callDynamicTool(run, params);
      this.respond(id, result);
      return;
    }

    this.respond(id, { decision: "cancel" });
  }

  private async callDynamicTool(
    run: ActiveRun,
    params: Record<string, unknown>,
  ): Promise<DynamicToolResult> {
    if (!run.sink.callTool) {
      return dynamicFailure("Dynamic tools are not available for this run");
    }
    const threadId = typeof params.threadId === "string" ? params.threadId : "";
    const turnId = typeof params.turnId === "string" ? params.turnId : "";
    const callId = typeof params.callId === "string" ? params.callId : "";
    const tool = typeof params.tool === "string" ? params.tool : "";
    const namespace = typeof params.namespace === "string" ? params.namespace : null;
    if (!threadId || !turnId || !callId || !tool) {
      return dynamicFailure("Invalid dynamic tool call payload");
    }
    const route = resolveCodexDynamicToolCall(run.dynamicToolRoutes, namespace, tool);
    if (!route) return dynamicFailure(`Unknown dynamic tool: ${namespace ?? tool}`);
    try {
      return await run.sink.callTool({
        threadId,
        turnId,
        callId,
        namespace: route.namespace,
        tool: route.tool,
        arguments: params.arguments,
      });
    } catch (error) {
      return dynamicFailure(errorMessage(error));
    }
  }

  private findRun(threadId: string, turnId: string | null): ActiveRun | undefined {
    for (const run of this.activeRuns.values()) {
      if (run.nativeThreadId !== threadId) continue;
      if (turnId && run.nativeTurnId && run.nativeTurnId !== turnId) continue;
      return run;
    }
    return undefined;
  }

  private findRunByTurn(turnId: string | null): ActiveRun | undefined {
    if (!turnId) return undefined;
    for (const run of this.activeRuns.values()) {
      if (run.nativeTurnId === turnId) return run;
    }
    return undefined;
  }

  private settleRun(run: ActiveRun, status: string, error?: string): void {
    if (run.finished) return;
    run.finished = true;
    const normalized: AgentRunResult["status"] =
      status === "completed"
        ? "succeeded"
        : status === "interrupted"
          ? "interrupted"
          : status === "cancelled"
            ? "cancelled"
            : "failed";
    const result: AgentRunResult = {
      status: normalized,
      nativeThreadId: run.nativeThreadId ?? "",
      nativeTurnId: run.nativeTurnId ?? "",
      output: run.output,
      ...(run.structuredOutput !== undefined ? { structuredOutput: run.structuredOutput } : {}),
      ...(normalized === "failed"
        ? { error: error ?? `Codex turn ended with status ${status}` }
        : {}),
    };
    if (run.nativeThreadId) this.activeRuns.delete(run.nativeThreadId);
    run.resolve(result);
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const process = this.process;
    if (!process) throw new Error("Codex app-server is not running");
    const stdin = requireProcessInput(process);
    const id = this.requestId++;
    const payload: JsonRpcRequest = { method, id, params };
    const response = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex RPC timed out: ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      stdin.write(`${JSON.stringify(payload)}\n`);
      void stdin.flush();
    });
    return response;
  }

  private notify(method: string, params: unknown): void {
    const process = this.process;
    if (!process) throw new Error("Codex app-server is not running");
    const stdin = requireProcessInput(process);
    stdin.write(`${JSON.stringify({ method, params })}\n`);
    void stdin.flush();
  }

  private respond(id: number | string, result: unknown): void {
    const process = this.process;
    if (!process) return;
    const stdin = requireProcessInput(process);
    stdin.write(`${JSON.stringify({ id, result })}\n`);
    void stdin.flush();
  }

  async startRun(input: AgentRunInput, sink: AgentSink): Promise<AgentRunHandle> {
    await this.ensureStarted();
    const dynamicTools = input.dynamicTools ? compileCodexDynamicTools(input.dynamicTools) : null;

    let resultResolve!: (value: AgentRunResult) => void;
    let resultReject!: (error: Error) => void;
    const result = new Promise<AgentRunResult>((resolve, reject) => {
      resultResolve = resolve;
      resultReject = reject;
    });
    const active: ActiveRun = {
      nativeThreadId: input.nativeThreadId ?? null,
      nativeTurnId: null,
      output: "",
      sink,
      dynamicToolRoutes: dynamicTools?.routes ?? null,
      resolve: resultResolve,
      reject: resultReject,
      finished: false,
    };
    const key = input.nativeThreadId ?? createId("pending");
    this.activeRuns.set(key, active);

    try {
      let threadId = input.nativeThreadId;
      const model = input.model ?? this.config.model;
      if (threadId) {
        const resumed = (await this.request("thread/resume", {
          threadId,
          cwd: input.cwd,
          ...(model ? { model } : {}),
          ...(input.developerInstructions
            ? { developerInstructions: input.developerInstructions }
            : {}),
          approvalPolicy: "on-request",
          sandbox: input.sandbox,
          excludeTurns: true,
          ...(dynamicTools ? { dynamicTools: dynamicTools.tools } : {}),
        })) as CodexThreadResumeResult;
        threadId = resumed.thread.id;
      } else {
        const started = (await this.request("thread/start", {
          cwd: input.cwd,
          ...(model ? { model } : {}),
          ...(input.developerInstructions
            ? { developerInstructions: input.developerInstructions }
            : {}),
          approvalPolicy: "on-request",
          sandbox: input.sandbox,
          serviceName: "finalbot",
          ...(dynamicTools ? { dynamicTools: dynamicTools.tools } : {}),
        })) as CodexThreadStartResult;
        threadId = started.thread.id;
      }
      if (!threadId) throw new Error("Codex did not return a thread id");

      this.activeRuns.delete(key);
      active.nativeThreadId = threadId;
      this.activeRuns.set(threadId, active);
      await sink.event({ type: "thread", nativeThreadId: threadId });

      const started = (await this.request("turn/start", {
        threadId,
        input: [{ type: "text", text: input.prompt, text_elements: [] }],
        cwd: input.cwd,
        approvalPolicy: "on-request",
        sandboxPolicy:
          input.sandbox === "read-only"
            ? { type: "readOnly" }
            : input.sandbox === "danger-full-access"
              ? { type: "dangerFullAccess" }
              : { type: "workspaceWrite", writableRoots: [input.cwd], networkAccess: false },
        ...(model ? { model } : {}),
        ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
      })) as CodexTurnStartResult;
      active.nativeTurnId = started.turn.id;
      await sink.event({ type: "turn", nativeTurnId: started.turn.id });
    } catch (error) {
      this.activeRuns.delete(key);
      if (active.nativeThreadId) this.activeRuns.delete(active.nativeThreadId);
      active.reject(new Error(`Failed to start Codex run: ${errorMessage(error)}`));
    }

    return {
      result,
      interrupt: async () => {
        if (!active.nativeThreadId || !active.nativeTurnId) {
          this.settleRun(active, "cancelled");
          return;
        }
        try {
          await this.request("turn/interrupt", {
            threadId: active.nativeThreadId,
            turnId: active.nativeTurnId,
          });
        } catch {
          this.settleRun(active, "interrupted");
        }
      },
    };
  }

  private handleExit(code: number): void {
    const message = `Codex app-server exited with code ${code}${
      this.stderrTail ? `: ${this.stderrTail.trim()}` : ""
    }`;
    this.failAll(new Error(message));
    this.process = null;
    this.initialized = false;
    this.stdoutReader = null;
    this.stderrReader = null;
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const run of this.activeRuns.values()) {
      if (!run.finished) {
        run.finished = true;
        run.reject(error);
      }
    }
    this.activeRuns.clear();
  }

  async close(): Promise<void> {
    this.failAll(new Error("Codex adapter closed"));
    const process = this.process;
    this.process = null;
    this.initialized = false;
    if (process) {
      process.kill();
      await process.exited.catch(() => undefined);
    }
  }
}

export class CodexAgentAdapter implements AgentAdapter {
  private readonly client: CodexAppServerClient;

  constructor(config: CodexAdapterConfig = {}) {
    this.client = new CodexAppServerClient(config);
  }

  start(input: AgentRunInput, sink: AgentSink): AgentRunHandle {
    let handlePromise: Promise<AgentRunHandle> | null = null;
    const result = (async () => {
      handlePromise = this.client.startRun(input, sink);
      const handle = await handlePromise;
      return handle.result;
    })();

    return {
      result,
      interrupt: async () => {
        const handle = handlePromise ? await handlePromise.catch(() => null) : null;
        await handle?.interrupt();
      },
    };
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

function toCommandDecision(decision: ApprovalDecision): CodexCommandApprovalDecision {
  switch (decision.action) {
    case "accept":
      return "accept";
    case "accept_session":
      return "acceptForSession";
    case "decline":
      return "decline";
    case "cancel":
      return "cancel";
  }
}

function toFileDecision(decision: ApprovalDecision): CodexFileChangeApprovalDecision {
  return toCommandDecision(decision);
}

export function compileCodexDynamicTools(tools: DynamicToolSpec[]): CompiledCodexDynamicTools {
  const flat: DynamicToolSpec[] = [];
  const namespaces = new Map<string, DynamicToolSpec[]>();
  for (const tool of tools) {
    const slash = tool.name.indexOf("/");
    if (slash <= 0 || slash === tool.name.length - 1) {
      flat.push(tool);
      continue;
    }
    const namespace = tool.name.slice(0, slash);
    const name = tool.name.slice(slash + 1);
    const group = namespaces.get(namespace) ?? [];
    group.push({ ...tool, name });
    namespaces.set(namespace, group);
  }
  const usedTopLevelNames = new Set<string>();
  const flatRoutes = new Map<string, string>();
  const compiledFlat = flat.map((tool) => {
    const codexName = uniqueCodexName(tool.name, usedTopLevelNames);
    flatRoutes.set(codexName, tool.name);
    return { ...tool, name: codexName };
  });
  const namespaceRoutes = new Map<string, CodexDynamicToolNamespaceRoute>();
  const compiledNamespaces = [...namespaces.entries()].map(([namespace, namespaceTools]) => {
    const codexNamespace = uniqueCodexName(namespace, usedTopLevelNames);
    const usedToolNames = new Set<string>();
    const route = new Map<string, string>();
    const compiledTools = namespaceTools.map((tool) => {
      const codexName = uniqueCodexName(tool.name, usedToolNames);
      route.set(codexName, tool.name);
      return { ...tool, name: codexName };
    });
    namespaceRoutes.set(codexNamespace, { namespace, tools: route });
    return {
      type: "namespace" as const,
      name: codexNamespace,
      description: `${namespace} tools`,
      tools: compiledTools,
    };
  });
  return {
    tools: [...compiledFlat, ...compiledNamespaces],
    routes: {
      flatTools: flatRoutes,
      namespaces: namespaceRoutes,
    },
  };
}

export function resolveCodexDynamicToolCall(
  routes: CodexDynamicToolRoutes | null,
  namespace: string | null,
  tool: string,
): { namespace: string | null; tool: string } | null {
  if (!routes) return null;
  if (namespace) {
    const route = routes.namespaces.get(namespace);
    const routedTool = route?.tools.get(tool);
    return route && routedTool ? { namespace: route.namespace, tool: routedTool } : null;
  }
  const routedTool = routes.flatTools.get(tool);
  return routedTool ? { namespace: null, tool: routedTool } : null;
}

function uniqueCodexName(value: string, used: Set<string>): string {
  const base = value.replaceAll(/[^a-zA-Z0-9_-]/g, "_") || "tool";
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  const suffix = createHash("sha256").update(value).digest("hex").slice(0, 8);
  let candidate = `${base}_${suffix}`;
  let counter = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${suffix}_${counter}`;
    counter += 1;
  }
  used.add(candidate);
  return candidate;
}

function dynamicFailure(message: string): DynamicToolResult {
  return {
    success: false,
    contentItems: [{ type: "inputText", text: JSON.stringify({ error: message }) }],
  };
}

function extractStructuredOutput(
  turn: Record<string, unknown> | null,
  params: Record<string, unknown>,
): unknown {
  if (turn && "outputSchema" in turn) return turn.outputSchema;
  if (turn && "structuredOutput" in turn) return turn.structuredOutput;
  if ("structuredOutput" in params) return params.structuredOutput;
  if ("outputSchema" in params) return params.outputSchema;
  return undefined;
}

function processEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function requireProcessInput(process: ReturnType<typeof Bun.spawn>): ProcessInput {
  const stdin = process.stdin as unknown;
  if (!stdin || typeof stdin === "number") {
    throw new Error("Codex app-server stdin is unavailable");
  }
  return stdin as ProcessInput;
}

export function agentEventsToText(events: AgentEvent[]): string {
  return events
    .filter((event) => event.type === "delta")
    .map((event) => event.text)
    .join("");
}
