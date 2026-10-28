import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboundEnvelope } from "@finalbot/core";
import { FinalBotDatabase } from "@finalbot/db";
import { QuickJsCodeSandbox } from "../../code-sandbox/src/index";
import { MemoryService, ScratchpadService } from "./memory";
import { ToolRegistry } from "./tools";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("memory and scratchpad", () => {
  test("isolates bot/owner scopes and layers scratchpad first", async () => {
    const db = await createDb();
    try {
      const memory = new MemoryService(db);
      const scratchpad = new ScratchpadService(db);
      const conversation = db.upsertConversation({
        channel: "web",
        accountId: "local",
        externalId: "main",
        conversationKind: "private",
      });
      memory.write(
        { scope: "bot", kind: "preference", content: "Prefer Chinese responses" },
        context("run-1", conversation.id, "coder"),
      );
      memory.write(
        { scope: "owner", kind: "identity", content: "Owner prefers concise answers" },
        context("run-2", conversation.id, "coder"),
      );
      scratchpad.set({
        conversationId: conversation.id,
        botId: "coder",
        content: { task: "review memory" },
      });
      const results = memory.search("", context("run-3", conversation.id, "coder"));
      expect(results.map((item) => item.scope)).toEqual(["scratchpad", "bot", "owner"]);
      const otherBot = memory.search("", context("run-4", conversation.id, "reviewer"));
      expect(otherBot.some((item) => item.scope === "bot")).toBe(false);
      expect(otherBot.some((item) => item.scope === "owner")).toBe(true);
    } finally {
      db.close();
    }
  });

  test("rejects secrets and enforces scratchpad revisions", async () => {
    const db = await createDb();
    try {
      const memory = new MemoryService(db);
      expect(() =>
        memory.write(
          { scope: "bot", kind: "note", content: "password=super-secret-value" },
          context("run", "conv", "coder"),
        ),
      ).toThrow();
      const scratchpad = new ScratchpadService(db);
      const conversation = db.upsertConversation({
        channel: "web",
        accountId: "local",
        externalId: "main",
        conversationKind: "private",
      });
      const first = scratchpad.set({
        conversationId: conversation.id,
        botId: "coder",
        content: { step: 1 },
        expectedRevision: 0,
      });
      expect(first.revision).toBe(1);
      expect(() =>
        scratchpad.set({
          conversationId: conversation.id,
          botId: "coder",
          content: { step: 2 },
          expectedRevision: 0,
        }),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  test("deduplicates writes and finds Chinese content and tags", async () => {
    const db = await createDb();
    try {
      const memory = new MemoryService(db);
      const invocation = context("run-cn", "conv-cn", "coder");
      const first = memory.write(
        {
          scope: "owner",
          kind: "project",
          content: "项目代号是朱雀，偏好中文回答",
          tags: ["项目", "中文"],
        },
        invocation,
      );
      const duplicate = memory.write(
        {
          scope: "owner",
          kind: "project",
          content: "  项目代号是朱雀，偏好中文回答 ",
          tags: ["项目", "中文", "长期"],
          confidence: 0.8,
        },
        invocation,
      );

      expect(duplicate.id).toBe(first.id);
      expect(memory.search("朱雀", invocation)).toEqual([
        expect.objectContaining({ id: first.id, scope: "owner", tags: ["项目", "中文", "长期"] }),
      ]);
      expect(memory.list({ scope: "owner", tag: "长期" }).map((item) => item.id)).toEqual([
        first.id,
      ]);

      memory.delete(first.id);
      expect(memory.list({ scope: "owner" })).toHaveLength(0);
      expect(memory.list({ scope: "owner", includeDeleted: true })[0]?.status).toBe("deleted");
      expect(
        memory.write(
          {
            scope: "owner",
            kind: "project",
            content: "项目代号是朱雀，偏好中文回答",
          },
          invocation,
        ).id,
      ).toBe(first.id);
    } finally {
      db.close();
    }
  });

  test("purges expired scratchpads", async () => {
    const db = await createDb();
    try {
      const conversation = db.upsertConversation({
        channel: "web",
        accountId: "local",
        externalId: "scratchpad-ttl",
        conversationKind: "private",
      });
      db.setScratchpad({
        conversationId: conversation.id,
        botId: "coder",
        content: { expired: true },
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      });
      expect(db.listScratchpads(conversation.id)).toHaveLength(0);
      expect(db.purgeExpiredScratchpads()).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("tool registry", () => {
  test("exposes and audits Sub Agent and Cross-Bot orchestration tools", async () => {
    const db = await createDb();
    try {
      const memory = new MemoryService(db);
      const scratchpad = new ScratchpadService(db);
      const calls: Array<Record<string, unknown>> = [];
      const registry = new ToolRegistry({
        db,
        memory,
        scratchpad,
        orchestration: {
          async spawnSubagent(prompt, context) {
            calls.push({ kind: "spawn", prompt, runId: context.runId });
            return { status: "succeeded", summary: { answer: 42 } };
          },
          async dispatchToBot(targetBotId, prompt, context) {
            calls.push({ kind: "dispatch", targetBotId, prompt, runId: context.runId });
            return { status: "succeeded", summary: { handedOff: true } };
          },
        },
      });
      const run = createRun(db);
      const context = {
        runId: run.id,
        conversationId: run.conversationId,
        botId: "coder",
        ownerId: "owner",
        toolSnapshotHash: registry.current().hash,
      };

      const bots = await registry.call(
        { namespace: "agent", tool: "list_bots", arguments: {} },
        context,
      );
      const spawned = await registry.call(
        {
          namespace: "agent",
          tool: "spawn",
          arguments: { prompt: "inspect the parser" },
        },
        context,
      );
      const dispatched = await registry.call(
        {
          namespace: "agent",
          tool: "dispatch",
          arguments: { botId: "reviewer", prompt: "review the patch" },
        },
        context,
      );

      expect(bots.success).toBe(true);
      expect(JSON.parse(bots.contentItems[0]?.text ?? "[]")).toEqual([
        expect.objectContaining({ id: "coder" }),
      ]);
      expect(spawned.success).toBe(true);
      expect(dispatched.success).toBe(true);
      expect(calls).toEqual([
        { kind: "spawn", prompt: "inspect the parser", runId: run.id },
        {
          kind: "dispatch",
          targetBotId: "reviewer",
          prompt: "review the patch",
          runId: run.id,
        },
      ]);
      expect(db.listToolCalls(run.id).map((call) => `${call.namespace}/${call.tool}`)).toEqual([
        "agent/list_bots",
        "agent/spawn",
        "agent/dispatch",
      ]);
    } finally {
      db.close();
    }
  });

  test("publishes immutable snapshots and audits calls", async () => {
    const db = await createDb();
    try {
      const memory = new MemoryService(db);
      const scratchpad = new ScratchpadService(db);
      const registry = new ToolRegistry({ db, memory, scratchpad });
      const first = registry.current();
      const run = createRun(db);
      const result = await registry.call(
        {
          namespace: "memory",
          tool: "write",
          arguments: { scope: "owner", kind: "preference", content: "Use Chinese" },
        },
        { runId: run.id, conversationId: run.conversationId, botId: "coder", ownerId: "owner" },
      );
      expect(result.success).toBe(true);
      expect(registry.current().revision).toBe(first.revision);
      expect(db.listToolCalls(run.id)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("runs Code Mode through the registry and audits the parent tool call", async () => {
    const db = await createDb();
    try {
      const memory = new MemoryService(db);
      const scratchpad = new ScratchpadService(db);
      const registry = new ToolRegistry({
        db,
        memory,
        scratchpad,
        sandbox: new QuickJsCodeSandbox({ timeoutMs: 5_000 }),
      });
      const run = createRun(db);
      const result = await registry.call(
        {
          namespace: "code",
          tool: "execute",
          arguments: {
            code: `
              const first = await tools.memory.write({
                scope: "owner",
                kind: "preference",
                content: "Use Chinese in code mode"
              });
              const found = await tools.memory.search({ query: "Chinese" });
              return { id: first.id, found: found.length };
            `,
          },
        },
        {
          runId: run.id,
          conversationId: run.conversationId,
          botId: "coder",
          ownerId: "owner",
          toolSnapshotHash: registry.current().hash,
        },
      );
      expect(result.success).toBe(true);
      expect(JSON.parse(result.contentItems[0]?.text ?? "{}")).toMatchObject({ found: 1 });
      expect(db.listToolCalls(run.id).map((call) => `${call.namespace}/${call.tool}`)).toEqual([
        "code/execute",
        "memory/write",
        "memory/search",
      ]);
      const executions = db.listCodeExecutions(run.id);
      expect(executions).toHaveLength(1);
      expect(executions[0]?.status).toBe("succeeded");
      expect(db.listCodeExecutionCalls(executions[0]?.id ?? "")).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  test("resumes Code Mode from a new Run without repeating journaled side effects", async () => {
    const db = await createDb();
    try {
      const memory = new MemoryService(db);
      const scratchpad = new ScratchpadService(db);
      let externalCalls = 1;
      const remoteTool = {
        namespace: "mcp.demo",
        name: "increment",
        description: "increments a remote counter",
        inputSchema: { type: "object", properties: {} },
        policy: "auto" as const,
        execute: async () => ({ count: ++externalCalls }),
      };
      const registry = new ToolRegistry({
        db,
        memory,
        scratchpad,
        sandbox: new QuickJsCodeSandbox({ timeoutMs: 5_000 }),
      });
      const originalSnapshot = registry.replaceMcpTools([remoteTool]);
      const originalRun = createRun(db);
      db.updateRun(originalRun.id, {
        toolRevision: originalSnapshot.revision,
        toolSnapshotHash: originalSnapshot.hash,
        toolSnapshotJson: JSON.stringify(
          originalSnapshot.tools.map((tool) => ({
            namespace: tool.namespace,
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            policy: tool.policy,
          })),
        ),
      });
      const code = `
        const first = await tools.mcp.demo.increment({});
        const second = await tools.mcp.demo.increment({});
        return { first, second };
      `;
      db.createCodeExecution({
        id: "execution-resume",
        runId: originalRun.id,
        code,
      });
      db.updateCodeExecution("execution-resume", { status: "waiting_approval" });
      db.upsertCodeExecutionCall({
        executionId: "execution-resume",
        callIndex: 0,
        toolPath: "mcp.demo/increment",
        arguments: {},
        result: { count: 1 },
        status: "succeeded",
      });

      const restarted = new ToolRegistry({
        db,
        memory,
        scratchpad,
        sandbox: new QuickJsCodeSandbox({ timeoutMs: 5_000 }),
      });
      const restartedSnapshot = restarted.replaceMcpTools([remoteTool]);
      expect(restartedSnapshot.hash).toBe(originalSnapshot.hash);
      const resumedRun = createRun(db);
      const result = await restarted.call(
        { namespace: "code", tool: "resume", arguments: { executionId: "execution-resume" } },
        {
          runId: resumedRun.id,
          conversationId: resumedRun.conversationId,
          botId: "coder",
          ownerId: "owner",
          toolSnapshotHash: restartedSnapshot.hash,
        },
      );

      expect(result.success).toBe(true);
      expect(JSON.parse(result.contentItems[0]?.text ?? "null")).toEqual({
        first: { count: 1 },
        second: { count: 2 },
      });
      expect(externalCalls).toBe(2);
      expect(db.listCodeExecutionCalls("execution-resume")).toHaveLength(2);
      expect(
        db.listToolCalls(resumedRun.id).map((call) => `${call.namespace}/${call.tool}`),
      ).toEqual(["code/resume", "mcp.demo/increment"]);
    } finally {
      db.close();
    }
  });

  test("restores persisted snapshot metadata and never falls back to newer tools", async () => {
    const db = await createDb();
    try {
      const memory = new MemoryService(db);
      const scratchpad = new ScratchpadService(db);
      const original = new ToolRegistry({ db, memory, scratchpad });
      const snapshot = original.replaceMcpTools([
        {
          namespace: "mcp.old",
          name: "removed_tool",
          description: "was present in the old snapshot",
          inputSchema: { type: "object" },
          policy: "auto",
          execute: async () => ({ ok: true }),
        },
      ]);
      const run = createRun(db);
      db.updateRun(run.id, {
        toolRevision: snapshot.revision,
        toolSnapshotHash: snapshot.hash,
        toolSnapshotJson: JSON.stringify(
          snapshot.tools.map((tool) => ({
            namespace: tool.namespace,
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            policy: tool.policy,
          })),
        ),
      });

      const restarted = new ToolRegistry({ db, memory, scratchpad });
      expect(restarted.has(snapshot.hash)).toBe(true);
      const result = await restarted.call(
        { namespace: "mcp.old", tool: "removed_tool", arguments: {} },
        {
          runId: run.id,
          conversationId: run.conversationId,
          botId: "coder",
          ownerId: "owner",
          toolSnapshotHash: snapshot.hash,
        },
      );
      expect(result.success).toBe(false);
      expect(result.contentItems[0]?.text).toContain("no longer available");
    } finally {
      db.close();
    }
  });

  test("requires approval for ask-policy MCP tools", async () => {
    const db = await createDb();
    try {
      const memory = new MemoryService(db);
      const scratchpad = new ScratchpadService(db);
      let approvals = 0;
      const registry = new ToolRegistry({
        db,
        memory,
        scratchpad,
        async requestApproval() {
          approvals += 1;
          return { action: "decline" };
        },
      });
      registry.replaceMcpTools([
        {
          namespace: "mcp.demo",
          name: "mutate",
          description: "mutates remote state",
          inputSchema: { type: "object" },
          policy: "ask",
          execute: async () => ({ ok: true }),
        },
      ]);
      const run = createRun(db);
      const result = await registry.call(
        { namespace: "mcp.demo", tool: "mutate", arguments: {} },
        {
          runId: run.id,
          conversationId: run.conversationId,
          botId: "coder",
          ownerId: "owner",
          toolSnapshotHash: registry.current().hash,
        },
      );
      expect(result.success).toBe(false);
      expect(approvals).toBe(1);
      expect(db.listToolCalls(run.id)[0]?.status).toBe("denied");
    } finally {
      db.close();
    }
  });

  test("marks Code Mode executions as waiting while an MCP approval is pending", async () => {
    const db = await createDb();
    try {
      const memory = new MemoryService(db);
      const scratchpad = new ScratchpadService(db);
      const run = createRun(db);
      let observedWaiting = false;
      const registry = new ToolRegistry({
        db,
        memory,
        scratchpad,
        sandbox: new QuickJsCodeSandbox({ timeoutMs: 5_000 }),
        async requestApproval() {
          observedWaiting = db
            .listCodeExecutions(run.id)
            .some((execution) => execution.status === "waiting_approval");
          return { action: "decline" };
        },
      });
      registry.replaceMcpTools([
        {
          namespace: "mcp.demo",
          name: "mutate",
          description: "mutates remote state",
          inputSchema: { type: "object" },
          policy: "ask",
          execute: async () => ({ ok: true }),
        },
      ]);
      const result = await registry.call(
        {
          namespace: "code",
          tool: "execute",
          arguments: {
            code: `
              try {
                await tools.mcp.demo.mutate({});
                return "unexpected";
              } catch (error) {
                return String(error);
              }
            `,
          },
        },
        {
          runId: run.id,
          conversationId: run.conversationId,
          botId: "coder",
          ownerId: "owner",
          toolSnapshotHash: registry.current().hash,
        },
      );
      expect(result.success).toBe(true);
      expect(observedWaiting).toBe(true);
      expect(db.listCodeExecutions(run.id)[0]?.status).toBe("succeeded");
      expect(db.listToolCalls(run.id).map((call) => call.status)).toEqual(["succeeded", "denied"]);
    } finally {
      db.close();
    }
  });

  test("denies reading another bot's private memory through tools", async () => {
    const db = await createDb();
    try {
      const memory = new MemoryService(db);
      const scratchpad = new ScratchpadService(db);
      const other = memory.write(
        { scope: "bot", kind: "private", content: "reviewer-only" },
        context("run-owner", "conversation", "reviewer"),
      );
      const registry = new ToolRegistry({ db, memory, scratchpad });
      const run = createRun(db);
      const result = await registry.call(
        { namespace: "memory", tool: "get", arguments: { id: other.id } },
        {
          runId: run.id,
          conversationId: run.conversationId,
          botId: "coder",
          ownerId: "owner",
        },
      );
      expect(result.success).toBe(false);
      expect(result.contentItems[0]?.text).toContain("outside this bot");
    } finally {
      db.close();
    }
  });
});

async function createDb(): Promise<FinalBotDatabase> {
  const dir = await mkdtemp(join(tmpdir(), "finalbot-runtime-"));
  dirs.push(dir);
  return new FinalBotDatabase(join(dir, "test.sqlite"));
}

function context(runId: string, conversationId: string, botId: string) {
  return { runId, conversationId, botId, ownerId: "owner" };
}

function createRun(db: FinalBotDatabase) {
  const conversation = db.upsertConversation({
    channel: "web",
    accountId: "local",
    externalId: "tools",
    conversationKind: "private",
  });
  return db.createRun({
    conversationId: conversation.id,
    prompt: "test",
    botId: "coder",
    botName: "Coder",
    agent: "codex",
  });
}

export function ownerMessage(): InboundEnvelope {
  return {
    channelId: "onebot",
    accountId: "bot",
    externalConversationId: "private:owner",
    conversationKind: "private",
    externalMessageId: "m1",
    senderId: "1",
    text: "hello",
    mentions: [],
    botMentioned: false,
    botRepliedTo: false,
    receivedAt: new Date().toISOString(),
    replyAddress: { channelId: "onebot", accountId: "bot", data: {} },
    raw: {},
  };
}
