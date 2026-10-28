import { createHash } from "node:crypto";
import type {
  ApprovalDecision,
  CodeSandbox,
  DynamicToolResult,
  DynamicToolSpec,
  PendingApproval,
  ToolDefinition,
  ToolInvocationContext,
  ToolSnapshot,
} from "@finalbot/core";
import type { FinalBotDatabase } from "@finalbot/db";
import type { MemoryService, ScratchpadService } from "./memory";

export interface ToolRegistryOptions {
  db: FinalBotDatabase;
  memory: MemoryService;
  scratchpad: ScratchpadService;
  sandbox?: CodeSandbox;
  requestApproval?: (request: Omit<PendingApproval, "runId">) => Promise<ApprovalDecision>;
  orchestration?: {
    spawnSubagent(prompt: string, context: ToolInvocationContext): Promise<unknown>;
    dispatchToBot(
      targetBotId: string,
      prompt: string,
      context: ToolInvocationContext,
    ): Promise<unknown>;
  };
}

export class ToolRegistry {
  private revision = 0;
  private snapshot: ToolSnapshot = { revision: 0, hash: emptyHash(), tools: [] };
  private readonly snapshots = new Map<string, ToolSnapshot>();
  private readonly sessionApproved = new Set<string>();
  private mcpTools: ToolDefinition[] = [];

  constructor(private readonly options: ToolRegistryOptions) {
    this.rebuild();
  }

  current(): ToolSnapshot {
    return this.snapshot;
  }

  get(hash: string | null | undefined): ToolSnapshot {
    if (!hash) return this.snapshot;
    return this.snapshots.get(hash) ?? this.restorePersistedSnapshot(hash) ?? this.snapshot;
  }

  has(hash: string | null | undefined): boolean {
    return Boolean(hash && (this.snapshots.has(hash) || this.restorePersistedSnapshot(hash)));
  }

  replaceMcpTools(tools: ToolDefinition[]): ToolSnapshot {
    this.mcpTools = tools;
    return this.rebuild();
  }

  specs(snapshot = this.snapshot): DynamicToolSpec[] {
    return snapshot.tools.map((tool) => ({
      type: "function",
      name: `${tool.namespace}/${tool.name}`,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  async call(
    input: {
      namespace?: string | null;
      tool: string;
      arguments: unknown;
    },
    context: ToolInvocationContext,
  ): Promise<DynamicToolResult> {
    if (context.toolSnapshotHash && !this.has(context.toolSnapshotHash)) {
      return failure(`Tool snapshot is unavailable: ${context.toolSnapshotHash}`);
    }
    const tool = this.get(context.toolSnapshotHash).tools.find(
      (candidate) =>
        candidate.name === input.tool &&
        candidate.namespace === (input.namespace ?? candidate.namespace),
    );
    if (!tool) {
      return failure(`Unknown tool: ${input.namespace ? `${input.namespace}/` : ""}${input.tool}`);
    }
    if (tool.policy === "deny") return failure(`Tool is denied: ${tool.namespace}/${tool.name}`);
    const record = this.options.db.createToolCall({
      runId: context.runId,
      namespace: tool.namespace,
      tool: tool.name,
      arguments: input.arguments,
    });
    try {
      if (tool.policy === "ask") {
        const approvalKey = `${context.conversationId}:${context.botId}:${tool.namespace}/${tool.name}`;
        if (!this.sessionApproved.has(approvalKey)) {
          const approve = this.options.requestApproval ?? context.requestApproval;
          if (!approve) {
            this.options.db.finishToolCall({
              id: record.id,
              status: "denied",
              error: "Approval unavailable",
            });
            return failure(
              `Tool requires approval but no approval broker is available: ${tool.namespace}/${tool.name}`,
            );
          }
          await context.onToolApprovalWait?.(true);
          let decision: ApprovalDecision;
          try {
            decision = await approve({
              requestId: record.id,
              kind: "mcp",
              title: `允许调用 ${tool.namespace}/${tool.name}`,
              detail: stringifyApprovalArguments(input.arguments),
              canAcceptForSession: true,
              payload: {
                namespace: tool.namespace,
                tool: tool.name,
                arguments: input.arguments,
              },
            });
          } finally {
            await context.onToolApprovalWait?.(false);
          }
          if (decision.action === "decline" || decision.action === "cancel") {
            this.options.db.finishToolCall({
              id: record.id,
              status: "denied",
              error: `Approval ${decision.action}`,
            });
            return failure(`Tool call was not approved: ${tool.namespace}/${tool.name}`);
          }
          if (decision.action === "accept_session") {
            this.sessionApproved.add(approvalKey);
          }
        }
      }
      const result = await tool.execute(input.arguments, context);
      this.options.db.finishToolCall({
        id: record.id,
        status: "succeeded",
        result,
      });
      return {
        success: true,
        contentItems: [{ type: "inputText", text: stringifyResult(result) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.db.finishToolCall({
        id: record.id,
        status: "failed",
        error: message,
      });
      return failure(message);
    }
  }

  private rebuild(): ToolSnapshot {
    this.revision += 1;
    const tools = [
      ...builtinTools(this.options.memory, this.options.scratchpad),
      ...orchestrationTools(this.options.db, this.options.orchestration),
      ...(this.options.sandbox
        ? codeModeTools({
            db: this.options.db,
            sandbox: this.options.sandbox,
            registry: (context) => this.get(context.toolSnapshotHash),
            hasSnapshot: (context) => this.has(context.toolSnapshotHash),
            invoke: (input, context) => this.call(input, context),
          })
        : []),
      ...this.mcpTools,
    ];
    this.snapshot = {
      revision: this.revision,
      hash: hashTools(tools),
      tools,
    };
    this.snapshots.set(this.snapshot.hash, this.snapshot);
    this.pruneSnapshots();
    return this.snapshot;
  }

  private restorePersistedSnapshot(hash: string): ToolSnapshot | null {
    const serialized = this.options.db.findToolSnapshotJson(hash);
    if (!serialized) return null;
    let records: unknown;
    try {
      records = JSON.parse(serialized);
    } catch {
      return null;
    }
    if (!Array.isArray(records)) return null;
    const liveByPath = new Map(
      this.snapshot.tools.map((tool) => [`${tool.namespace}/${tool.name}`, tool]),
    );
    const tools: ToolDefinition[] = [];
    for (const value of records) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      if (
        typeof record.namespace !== "string" ||
        typeof record.name !== "string" ||
        typeof record.description !== "string" ||
        !record.inputSchema ||
        typeof record.inputSchema !== "object" ||
        Array.isArray(record.inputSchema)
      ) {
        continue;
      }
      const policy = record.policy === "auto" || record.policy === "deny" ? record.policy : "ask";
      const path = `${record.namespace}/${record.name}`;
      const live = liveByPath.get(path);
      const sameDefinition =
        live &&
        live.description === record.description &&
        JSON.stringify(live.inputSchema) === JSON.stringify(record.inputSchema) &&
        live.policy === policy;
      tools.push({
        namespace: record.namespace,
        name: record.name,
        description: record.description,
        inputSchema: record.inputSchema as Record<string, unknown>,
        policy,
        execute: sameDefinition
          ? live.execute.bind(live)
          : async () => {
              throw new Error(`Tool is no longer available in snapshot ${hash}: ${path}`);
            },
      });
    }
    if (tools.length === 0) return null;
    const restored: ToolSnapshot = {
      revision: 0,
      hash,
      tools,
    };
    this.snapshots.set(hash, restored);
    this.pruneSnapshots();
    return restored;
  }

  private pruneSnapshots(): void {
    const limit = 64;
    while (this.snapshots.size > limit) {
      const oldest = this.snapshots.keys().next().value;
      if (!oldest || oldest === this.snapshot.hash) break;
      this.snapshots.delete(oldest);
    }
  }
}

function codeModeTools(options: {
  db: FinalBotDatabase;
  sandbox: CodeSandbox;
  registry: (context: ToolInvocationContext) => ToolSnapshot;
  hasSnapshot: (context: ToolInvocationContext) => boolean;
  invoke(
    input: { namespace?: string | null; tool: string; arguments: unknown },
    context: ToolInvocationContext,
  ): Promise<DynamicToolResult>;
}): ToolDefinition[] {
  return [
    {
      namespace: "code",
      name: "search",
      description: "Search available tool namespaces and tools.",
      policy: "auto",
      inputSchema: objectSchema({ query: { type: "string" }, limit: { type: "number" } }),
      execute: async (input, context) => {
        const args = asRecord(input);
        const query = optionalString(args, "query")?.toLocaleLowerCase() ?? "";
        const limit = Math.max(1, Math.min(typeof args.limit === "number" ? args.limit : 50, 100));
        return options
          .registry(context)
          .tools.filter(
            (tool) =>
              tool.namespace !== "code" &&
              (!query ||
                `${tool.namespace}/${tool.name} ${tool.description}`
                  .toLocaleLowerCase()
                  .includes(query)),
          )
          .slice(0, limit)
          .map((tool) => ({
            path: `${tool.namespace}/${tool.name}`,
            description: tool.description,
            policy: tool.policy,
          }));
      },
    },
    {
      namespace: "code",
      name: "describe",
      description: "Describe one available tool and its input schema.",
      policy: "auto",
      inputSchema: objectSchema({ path: { type: "string" } }, ["path"]),
      execute: async (input, context) => {
        const path = stringArg(asRecord(input), "path");
        const tool = findToolByPath(options.registry(context), path);
        if (!tool || tool.namespace === "code") throw new Error(`Unknown tool: ${path}`);
        return {
          path: `${tool.namespace}/${tool.name}`,
          description: tool.description,
          inputSchema: tool.inputSchema,
          policy: tool.policy,
        };
      },
    },
    {
      namespace: "code",
      name: "call",
      description: "Call one available tool by namespace/name path.",
      policy: "auto",
      inputSchema: objectSchema({ path: { type: "string" }, arguments: { type: "object" } }, [
        "path",
      ]),
      execute: async (input, context) => {
        const args = asRecord(input);
        const path = stringArg(args, "path");
        if (path.startsWith("code/")) throw new Error("Code Mode tools cannot call themselves");
        const tool = findToolByPath(options.registry(context), path);
        if (!tool) throw new Error(`Unknown tool: ${path}`);
        const result = await options.invoke(
          { namespace: tool.namespace, tool: tool.name, arguments: args.arguments ?? {} },
          context,
        );
        if (!result.success) throw new Error(resultText(result));
        return parseToolResult(result);
      },
    },
    {
      namespace: "code",
      name: "execute",
      description:
        "Execute JavaScript in an isolated QuickJS sandbox. Access tools through tools.<namespace>.<tool>(arguments).",
      policy: "auto",
      inputSchema: objectSchema({ code: { type: "string" } }, ["code"]),
      execute: async (input, context) => {
        const code = stringArg(asRecord(input), "code");
        if (Buffer.byteLength(code) > 1024 * 1024) throw new Error("Code exceeds 1 MiB");
        const executionId = createHash("sha256")
          .update(`${context.runId}:${Date.now()}:${code}`)
          .digest("hex")
          .slice(0, 24);
        const record = options.db.createCodeExecution({
          id: executionId,
          runId: context.runId,
          code,
        });
        const executionContext: ToolInvocationContext = {
          ...context,
          onToolApprovalWait: async (waiting) => {
            options.db.updateCodeExecution(executionId, {
              status: waiting ? "waiting_approval" : "running",
            });
            await context.onToolApprovalWait?.(waiting);
          },
        };
        const journal = new Map<string, unknown>();
        const result = await options.sandbox.run({
          code,
          journal,
          callTool: async (path, args) => {
            const tool = findToolByPath(options.registry(context), path);
            if (!tool) throw new Error(`Unknown tool: ${path}`);
            if (tool.namespace === "code")
              throw new Error("Code Mode tools cannot call themselves");
            const invoked = await options.invoke(
              { namespace: tool.namespace, tool: tool.name, arguments: args },
              executionContext,
            );
            if (!invoked.success) throw new Error(resultText(invoked));
            return parseToolResult(invoked);
          },
          onToolCall: async (call) => {
            options.db.upsertCodeExecutionCall({
              executionId,
              callIndex: call.index,
              toolPath: call.path,
              arguments: call.arguments,
              result: call.result,
              status: "succeeded",
            });
          },
        });
        options.db.updateCodeExecution(record.id, {
          status: result.success ? "succeeded" : "failed",
          result: {
            output: result.output,
            logs: result.logs,
            toolCalls: result.toolCalls,
          },
          ...(result.error ? { error: result.error } : {}),
        });
        if (!result.success) throw new Error(result.error ?? "Code execution failed");
        return result.output;
      },
    },
    {
      namespace: "code",
      name: "resume",
      description: "Resume a paused code execution id with its persisted tool journal.",
      policy: "auto",
      inputSchema: objectSchema({ executionId: { type: "string" } }, ["executionId"]),
      execute: async (input, context) => {
        const executionId = stringArg(asRecord(input), "executionId");
        const existing = options.db.getCodeExecution(executionId);
        if (!existing) {
          throw new Error(`Code execution not found: ${executionId}`);
        }
        const originalRun = options.db.getRun(existing.runId);
        if (
          !originalRun ||
          originalRun.conversationId !== context.conversationId ||
          originalRun.botId !== context.botId
        ) {
          throw new Error(`Code execution ${executionId} belongs to another conversation or bot`);
        }
        const originalHash = originalRun.toolSnapshotHash;
        const registryContext: ToolInvocationContext = {
          ...context,
          ...(originalHash ? { toolSnapshotHash: originalHash } : {}),
        };
        if (originalHash && !options.hasSnapshot(registryContext)) {
          throw new Error(
            `Code execution ${executionId} was created with an unavailable tool snapshot`,
          );
        }
        const journal = new Map<string, unknown>();
        for (const call of options.db.listCodeExecutionCalls(executionId)) {
          journal.set(`call:${call.callIndex}`, call.result);
        }
        options.db.updateCodeExecution(executionId, { status: "running" });
        const executionContext: ToolInvocationContext = {
          ...registryContext,
          onToolApprovalWait: async (waiting) => {
            options.db.updateCodeExecution(executionId, {
              status: waiting ? "waiting_approval" : "running",
            });
            await context.onToolApprovalWait?.(waiting);
          },
        };
        const result = await options.sandbox.run({
          code: existing.code,
          journal,
          callTool: async (path, args) => {
            const tool = findToolByPath(options.registry(registryContext), path);
            if (!tool) throw new Error(`Unknown tool: ${path}`);
            if (tool.namespace === "code") {
              throw new Error("Code Mode tools cannot call themselves");
            }
            const invoked = await options.invoke(
              { namespace: tool.namespace, tool: tool.name, arguments: args },
              executionContext,
            );
            if (!invoked.success) throw new Error(resultText(invoked));
            return parseToolResult(invoked);
          },
          onToolCall: async (call) => {
            options.db.upsertCodeExecutionCall({
              executionId,
              callIndex: call.index,
              toolPath: call.path,
              arguments: call.arguments,
              result: call.result,
              status: "succeeded",
            });
          },
        });
        options.db.updateCodeExecution(executionId, {
          status: result.success ? "succeeded" : "failed",
          result,
          ...(result.error ? { error: result.error } : {}),
        });
        if (!result.success) throw new Error(result.error ?? "Code execution failed");
        return result.output;
      },
    },
  ];
}

function orchestrationTools(
  db: FinalBotDatabase,
  orchestration: ToolRegistryOptions["orchestration"],
): ToolDefinition[] {
  if (!orchestration) return [];
  return [
    {
      namespace: "agent",
      name: "list_bots",
      description: "List enabled Bots that can receive a Cross-Bot dispatch.",
      policy: "auto",
      inputSchema: objectSchema({}),
      execute: async () => {
        return db
          .listBotProfiles()
          .filter((bot) => bot.enabled)
          .map((bot) => ({
            id: bot.id,
            name: bot.name,
            description: bot.description,
            agent: bot.agent,
            model: bot.model,
          }));
      },
    },
    {
      namespace: "agent",
      name: "spawn",
      description:
        "Run a Sub Agent in the parent workspace with an isolated Codex thread and return its structured summary. Nested Sub Agents are forbidden.",
      policy: "auto",
      inputSchema: objectSchema({ prompt: { type: "string" } }, ["prompt"]),
      execute: async (input, context) => {
        const prompt = stringArg(asRecord(input), "prompt");
        return orchestration.spawnSubagent(prompt, context);
      },
    },
    {
      namespace: "agent",
      name: "dispatch",
      description:
        "Send a task to another enabled Bot and return its structured summary. Hop, fan-out, duplicate and cycle limits are enforced.",
      policy: "auto",
      inputSchema: objectSchema(
        {
          botId: { type: "string" },
          prompt: { type: "string" },
        },
        ["botId", "prompt"],
      ),
      execute: async (input, context) => {
        const args = asRecord(input);
        return orchestration.dispatchToBot(
          stringArg(args, "botId"),
          stringArg(args, "prompt"),
          context,
        );
      },
    },
  ];
}

function findToolByPath(snapshot: ToolSnapshot, path: string): ToolDefinition | null {
  const separator = path.lastIndexOf("/");
  if (separator <= 0) {
    return snapshot.tools.find((tool) => `${tool.namespace}.${tool.name}` === path) ?? null;
  }
  const namespace = path.slice(0, separator).replaceAll("/", ".");
  const name = path.slice(separator + 1);
  return snapshot.tools.find((tool) => tool.namespace === namespace && tool.name === name) ?? null;
}

function resultText(result: DynamicToolResult): string {
  return result.contentItems.map((item) => item.text).join("\n");
}

function parseToolResult(result: DynamicToolResult): unknown {
  const text = resultText(result);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function stringifyApprovalArguments(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > 2_000 ? `${text.slice(0, 2_000)}\n...` : text;
}

export function builtinTools(
  memory: MemoryService,
  scratchpad: ScratchpadService,
): ToolDefinition[] {
  return [
    {
      namespace: "memory",
      name: "search",
      description: "Search scratchpad, bot memory, then owner memory.",
      policy: "auto",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          kind: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          limit: { type: "number" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      execute: async (input, context) => {
        const args = asRecord(input);
        const kind = optionalString(args, "kind");
        return memory.search(stringArg(args, "query"), context, {
          ...(kind ? { kind } : {}),
          ...(stringArray(args.tags).length > 0 ? { tags: stringArray(args.tags) } : {}),
          ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
        });
      },
    },
    {
      namespace: "memory",
      name: "get",
      description: "Read one memory by id.",
      policy: "auto",
      inputSchema: objectSchema({ id: { type: "string" } }, ["id"]),
      execute: async (input, context) => {
        const memoryRecord = memory.get(stringArg(asRecord(input), "id"));
        if (!memoryRecord) throw new Error("Memory not found");
        if (memoryRecord.scope === "bot" && memoryRecord.botId !== context.botId) {
          throw new Error("Memory is outside this bot's scope");
        }
        return memoryRecord;
      },
    },
    {
      namespace: "memory",
      name: "write",
      description: "Explicitly write owner or bot-scoped memory.",
      policy: "auto",
      inputSchema: objectSchema(
        {
          scope: { type: "string", enum: ["owner", "bot"] },
          kind: { type: "string" },
          content: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        ["scope", "kind", "content"],
      ),
      execute: async (input, context) => {
        if (!context.ownerId) throw new Error("Memory tools require an Owner context");
        const args = asRecord(input);
        return memory.write(
          {
            scope: args.scope === "owner" ? "owner" : "bot",
            kind: stringArg(args, "kind"),
            content: stringArg(args, "content"),
            tags: stringArray(args.tags),
            ...(typeof args.confidence === "number" ? { confidence: args.confidence } : {}),
          },
          context,
        );
      },
    },
    {
      namespace: "memory",
      name: "delete",
      description: "Soft-delete a memory. Permanent deletion is restricted to Web administration.",
      policy: "auto",
      inputSchema: objectSchema({ id: { type: "string" } }, ["id"]),
      execute: async (input, context) => {
        const args = asRecord(input);
        const id = stringArg(args, "id");
        const memoryRecord = memory.get(id);
        if (!memoryRecord) throw new Error("Memory not found");
        if (memoryRecord.scope === "bot" && memoryRecord.botId !== context.botId) {
          throw new Error("Memory is outside this bot's scope");
        }
        memory.delete(id, false);
        return { deleted: true };
      },
    },
    {
      namespace: "scratchpad",
      name: "get",
      description: "Read this conversation and bot scratchpad.",
      policy: "auto",
      inputSchema: objectSchema({}),
      execute: async (_input, context) => scratchpad.get(context.conversationId, context.botId),
    },
    {
      namespace: "scratchpad",
      name: "set",
      description: "Replace this conversation and bot scratchpad.",
      policy: "auto",
      inputSchema: objectSchema(
        {
          content: {},
          expectedRevision: { type: "number" },
          ttlDays: { type: "number" },
        },
        ["content"],
      ),
      execute: async (input, context) => {
        const args = asRecord(input);
        return scratchpad.set({
          conversationId: context.conversationId,
          botId: context.botId,
          content: args.content,
          ...(typeof args.expectedRevision === "number"
            ? { expectedRevision: args.expectedRevision }
            : {}),
          ...(typeof args.ttlDays === "number" ? { ttlDays: args.ttlDays } : {}),
        });
      },
    },
    {
      namespace: "scratchpad",
      name: "list",
      description: "List scratchpad revisions for this conversation.",
      policy: "auto",
      inputSchema: objectSchema({}),
      execute: async (_input, context) => scratchpad.list(context.conversationId),
    },
  ];
}

function hashTools(tools: ToolDefinition[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        tools.map((tool) => ({
          namespace: tool.namespace,
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          policy: tool.policy,
        })),
      ),
    )
    .digest("hex");
}

function emptyHash(): string {
  return createHash("sha256").update("[]").digest("hex");
}

function failure(message: string): DynamicToolResult {
  return {
    success: false,
    contentItems: [{ type: "inputText", text: JSON.stringify({ error: message }) }],
  };
}

function stringifyResult(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
  if (Buffer.byteLength(text) <= 256 * 1024) return text;
  return JSON.stringify({ truncated: true, preview: text.slice(0, 64 * 1024) });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tool arguments must be an object");
  }
  return value as Record<string, unknown>;
}

function stringArg(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value;
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}
