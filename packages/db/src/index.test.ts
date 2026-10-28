import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FinalBotDatabase } from "./index";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createDatabase(): Promise<FinalBotDatabase> {
  const dir = await mkdtemp(join(tmpdir(), "finalbot-db-"));
  tempDirs.push(dir);
  return new FinalBotDatabase(join(dir, "test.sqlite"));
}

describe("approval persistence", () => {
  test("keeps approval metadata and lists only pending approvals for a run", async () => {
    const db = await createDatabase();
    try {
      const conversation = db.upsertConversation({
        channel: "onebot",
        accountId: "bot",
        externalId: "group:1",
        conversationKind: "group",
      });
      const run = db.createRun({
        conversationId: conversation.id,
        prompt: "test",
        requestedBy: "10001",
        botId: "coder",
        botName: "Coder",
        agent: "codex",
      });
      const approval = db.createApproval({
        requestId: "approval_1",
        runId: run.id,
        kind: "command",
        title: "Approve command",
        detail: "npm test",
        canAcceptForSession: true,
        payload: {},
      });

      expect(approval.canAcceptForSession).toBe(true);
      expect(db.listPendingApprovals(run.id)).toHaveLength(1);

      db.resolveApproval("approval_1", { action: "decline" });
      expect(db.listPendingApprovals(run.id)).toHaveLength(0);
      expect(db.getApproval("approval_1")?.status).toBe("declined");
    } finally {
      db.close();
    }
  });

  test("expires pending approvals when active runs recover after restart", async () => {
    const db = await createDatabase();
    try {
      const conversation = db.upsertConversation({
        channel: "onebot",
        accountId: "bot",
        externalId: "private:1",
        conversationKind: "private",
      });
      const run = db.createRun({
        conversationId: conversation.id,
        prompt: "test",
        requestedBy: "10001",
        botId: "coder",
        botName: "Coder",
        agent: "codex",
      });
      db.updateRun(run.id, { state: "running" });
      db.createApproval({
        requestId: "approval_2",
        runId: run.id,
        kind: "command",
        title: "Approve command",
        detail: "npm test",
        canAcceptForSession: false,
        payload: {},
      });

      const recovered = db.recoverActiveRuns();
      expect(recovered).toHaveLength(1);
      expect(recovered[0]?.state).toBe("interrupted");
      expect(db.getApproval("approval_2")?.status).toBe("expired");
    } finally {
      db.close();
    }
  });
});

describe("durable events and recovery", () => {
  test("lists run events in sequence order after a cursor", async () => {
    const db = await createDatabase();
    try {
      const first = db.appendEvent({
        runId: null,
        type: "system",
        payload: { type: "system", message: "first" },
      });
      const second = db.appendEvent({
        runId: "run_1",
        type: "run.delta",
        payload: { type: "run.delta", text: "second" },
      });

      expect(db.listEventsAfter(0).map((event) => event.seq)).toEqual([first.seq, second.seq]);
      expect(db.listEventsAfter(first.seq)).toEqual([second]);
      expect(db.latestEventSeq()).toBe(second.seq);
    } finally {
      db.close();
    }
  });

  test("fails unfinished inbox work and requeues only pending conversations", async () => {
    const db = await createDatabase();
    try {
      const runningConversation = db.upsertConversation({
        channel: "onebot",
        accountId: "bot",
        externalId: "private:1",
        conversationKind: "private",
      });
      const pendingConversation = db.upsertConversation({
        channel: "onebot",
        accountId: "bot",
        externalId: "private:2",
        conversationKind: "private",
      });
      const running = db.admitInbound({
        conversationId: runningConversation.id,
        externalMessageId: "message-running",
        senderId: "1",
        text: "running",
        raw: {},
        receivedAt: new Date().toISOString(),
      }).item;
      db.admitInbound({
        conversationId: pendingConversation.id,
        externalMessageId: "message-pending",
        senderId: "2",
        text: "pending",
        raw: {},
        receivedAt: new Date().toISOString(),
      });
      db.markInboxRunning([running.id]);

      const recovered = db.recoverInboxAfterRestart();
      expect(recovered.failed).toBe(1);
      expect(recovered.conversations).toEqual([pendingConversation.id]);
      expect(db.getPendingInbox(runningConversation.id)).toHaveLength(0);
      const row = db.db
        .query("SELECT status, error FROM inbox_items WHERE id = ?")
        .get(running.id) as { status: string; error: string };
      expect(row.status).toBe("failed");
      expect(row.error).toContain("restarted");
    } finally {
      db.close();
    }
  });

  test("returns outbox metadata until delivery is marked", async () => {
    const db = await createDatabase();
    try {
      const id = db.enqueueOutbox("reply", {
        target: { kind: "onebot", messageType: "private", userId: "1" },
        text: "hello",
      });
      const pending = db.pendingOutbox();
      expect(pending).toEqual([
        {
          id,
          runId: null,
          type: "reply",
          payload: {
            target: { kind: "onebot", messageType: "private", userId: "1" },
            text: "hello",
          },
          attempts: 0,
          lastError: null,
          createdAt: expect.any(String),
        },
      ]);

      db.markOutboxDelivered(id);
      expect(db.pendingOutbox()).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});

describe("bot profiles and routing state", () => {
  test("migrates databases created before bot profiles existed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "finalbot-db-migration-"));
    tempDirs.push(dir);
    const path = join(dir, "old.sqlite");
    const legacy = new Database(path, { create: true, readwrite: true });
    legacy.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        account_id TEXT NOT NULL,
        external_id TEXT NOT NULL,
        conversation_kind TEXT NOT NULL,
        title TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(channel, account_id, external_id)
      );
      CREATE TABLE inbox_items (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        external_message_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        text TEXT NOT NULL,
        raw_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending',
        received_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(conversation_id, external_message_id)
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        prompt TEXT NOT NULL,
        state TEXT NOT NULL,
        agent TEXT NOT NULL,
        native_thread_id TEXT,
        native_turn_id TEXT,
        workspace_path TEXT,
        output TEXT NOT NULL DEFAULT '',
        error TEXT,
        reply_target_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      INSERT INTO conversations
        (id, channel, account_id, external_id, conversation_kind, metadata_json, created_at, updated_at)
      VALUES
        ('conv_old', 'onebot', 'bot', 'private:1', 'private', '{}', '2026-01-01', '2026-01-01');
      INSERT INTO inbox_items
        (id, conversation_id, external_message_id, sender_id, text, raw_json, status, received_at, created_at)
      VALUES
        ('inbox_old', 'conv_old', 'msg_old', '1', 'hello', '{}', 'pending', '2026-01-01', '2026-01-01');
      INSERT INTO runs
        (id, conversation_id, prompt, state, agent, output, error, reply_target_json, created_at, updated_at)
      VALUES
        ('run_old', 'conv_old', 'task', 'failed', 'codex', '', 'err',
         '{"kind":"onebot","messageType":"private","userId":"1"}',
         '2026-01-01', '2026-01-01');
    `);
    legacy.close();

    const db = new FinalBotDatabase(path);
    try {
      expect(db.getConversation("conv_old")?.activeBotId).toBe("coder");
      expect(db.getPendingInbox("conv_old")[0]?.botId).toBe("coder");
      expect(db.getRun("run_old")).toMatchObject({
        botId: "coder",
        botName: "Coder",
        model: null,
        replyAddress: {
          channelId: "onebot",
          accountId: "bot",
          data: { messageType: "private", userId: "1" },
        },
      });
      expect(db.listMessages("conv_old").length).toBeGreaterThanOrEqual(2);
      expect((await readdir(dir)).some((name) => name.includes(".bak"))).toBe(true);
      expect(db.getBotProfile("coder")?.enabled).toBe(true);
      expect(
        db.db
          .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
          .get("idx_inbox_conversation_bot"),
      ).not.toBeNull();
    } finally {
      db.close();
    }
  });

  test("seeds the default coder bot and persists profile updates", async () => {
    const db = await createDatabase();
    try {
      expect(db.getBotProfile("coder")).toMatchObject({
        id: "coder",
        name: "Coder",
        agent: "codex",
        enabled: true,
      });

      const reviewer = db.upsertBotProfile({
        id: "reviewer",
        name: "Reviewer",
        description: "Reviews changes",
        instructions: "Review code carefully.",
        agent: "codex",
        model: "review-model",
      });
      expect(reviewer).toMatchObject({
        id: "reviewer",
        name: "Reviewer",
        model: "review-model",
      });
      expect(db.listBotProfiles().map((bot) => bot.id)).toEqual(["coder", "reviewer"]);
    } finally {
      db.close();
    }
  });

  test("switches the active bot without changing queued inbox ownership", async () => {
    const db = await createDatabase();
    try {
      db.upsertBotProfile({
        id: "reviewer",
        name: "Reviewer",
        description: "Reviews changes",
        instructions: "Review code carefully.",
        agent: "codex",
      });
      const conversation = db.upsertConversation({
        channel: "onebot",
        accountId: "bot",
        externalId: "private:routing",
        conversationKind: "private",
      });
      expect(conversation.activeBotId).toBe("coder");

      db.admitInbound({
        conversationId: conversation.id,
        externalMessageId: "queued-coder",
        botId: "coder",
        senderId: "10001",
        text: "first",
        raw: {},
        receivedAt: new Date().toISOString(),
      });
      const switched = db.setConversationActiveBot(conversation.id, "reviewer");
      expect(switched.activeBotId).toBe("reviewer");

      expect(db.getPendingInbox(conversation.id).map((item) => item.botId)).toEqual(["coder"]);
      expect(db.getPendingInbox(conversation.id, "reviewer")).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("keeps agent sessions isolated by bot within one conversation", async () => {
    const db = await createDatabase();
    try {
      db.upsertBotProfile({
        id: "reviewer",
        name: "Reviewer",
        description: "Reviews changes",
        instructions: "Review code carefully.",
        agent: "codex",
      });
      const conversation = db.upsertConversation({
        channel: "onebot",
        accountId: "bot",
        externalId: "private:sessions",
        conversationKind: "private",
      });
      const coderRun = db.createRun({
        conversationId: conversation.id,
        prompt: "implementation",
        botId: "coder",
        botName: "Coder",
        agent: "codex",
      });
      db.updateRun(coderRun.id, { nativeThreadId: "thread_coder" });
      const reviewerRun = db.createRun({
        conversationId: conversation.id,
        prompt: "review",
        botId: "reviewer",
        botName: "Reviewer",
        agent: "codex",
      });
      db.updateRun(reviewerRun.id, { nativeThreadId: "thread_reviewer" });

      expect(db.getLatestConversationSession(conversation.id, "coder")).toEqual({
        nativeThreadId: "thread_coder",
      });
      expect(db.getLatestConversationSession(conversation.id, "reviewer")).toEqual({
        nativeThreadId: "thread_reviewer",
      });
    } finally {
      db.close();
    }
  });

  test("recovers inbox queues grouped by conversation and bot", async () => {
    const db = await createDatabase();
    try {
      db.upsertBotProfile({
        id: "reviewer",
        name: "Reviewer",
        description: "Reviews changes",
        instructions: "Review code carefully.",
        agent: "codex",
      });
      const conversation = db.upsertConversation({
        channel: "onebot",
        accountId: "bot",
        externalId: "private:recover-bots",
        conversationKind: "private",
      });
      for (const [id, botId] of [
        ["message-1", "coder"],
        ["message-2", "reviewer"],
      ] as const) {
        db.admitInbound({
          conversationId: conversation.id,
          externalMessageId: id,
          botId,
          senderId: "10001",
          text: id,
          raw: {},
          receivedAt: new Date().toISOString(),
        });
      }

      expect(db.recoverQueueAfterRestart().queues).toEqual([
        { conversationId: conversation.id, botId: "coder" },
        { conversationId: conversation.id, botId: "reviewer" },
      ]);
    } finally {
      db.close();
    }
  });
});

describe("owner identity and dispatch durability", () => {
  test("resolves group senders through a private identity alias", async () => {
    const db = await createDatabase();
    try {
      const owner = db.ensureOwner();
      db.bindOwnerIdentity({
        ownerId: owner.id,
        channelId: "qq",
        accountId: "app-1",
        senderId: "c2c-openid",
        conversationKind: "private",
        aliases: ["union-openid"],
        replyAddress: {
          channelId: "qq",
          accountId: "app-1",
          data: { kind: "c2c", targetId: "c2c-openid" },
        },
      });

      expect(
        db.resolveOwnerIdentity({
          channelId: "qq",
          accountId: "app-1",
          senderId: "group-member-openid",
          conversationKind: "group",
          aliases: ["union-openid"],
        }),
      ).toMatchObject({
        ownerId: owner.id,
        senderId: "c2c-openid",
        conversationKind: "private",
        aliases: ["union-openid"],
      });
    } finally {
      db.close();
    }
  });

  test("uses a dispatch key to make discuss delivery idempotent", async () => {
    const db = await createDatabase();
    try {
      const conversation = db.upsertConversation({
        channel: "web",
        accountId: "local",
        externalId: "dispatch",
        conversationKind: "private",
      });
      const first = db.createRun({
        conversationId: conversation.id,
        prompt: "hello",
        botId: "coder",
        botName: "Coder",
        agent: "codex",
        dispatchKey: "discuss:batch-1",
      });
      const second = db.createRun({
        conversationId: conversation.id,
        prompt: "hello again",
        botId: "coder",
        botName: "Coder",
        agent: "codex",
        dispatchKey: "discuss:batch-1",
      });
      expect(second.id).toBe(first.id);
      expect(db.listRuns()).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

describe("orchestration persistence", () => {
  test("migrates legacy orchestration tables in place", async () => {
    const dir = await mkdtemp(join(tmpdir(), "finalbot-db-orchestration-migration-"));
    tempDirs.push(dir);
    const path = join(dir, "old.sqlite");
    const legacy = new Database(path, { create: true, readwrite: true });
    legacy.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        account_id TEXT NOT NULL,
        external_id TEXT NOT NULL,
        conversation_kind TEXT NOT NULL,
        title TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(channel, account_id, external_id)
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        prompt TEXT NOT NULL,
        state TEXT NOT NULL,
        agent TEXT NOT NULL,
        native_thread_id TEXT,
        native_turn_id TEXT,
        workspace_path TEXT,
        output TEXT NOT NULL DEFAULT '',
        error TEXT,
        reply_target_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE TABLE subagent_tasks (
        id TEXT PRIMARY KEY,
        parent_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE agent_messages (
        id TEXT PRIMARY KEY,
        source_run_id TEXT NOT NULL,
        source_bot_id TEXT NOT NULL,
        target_bot_id TEXT NOT NULL,
        target_run_id TEXT,
        prompt TEXT NOT NULL,
        hop_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO conversations
        (id, channel, account_id, external_id, conversation_kind, metadata_json, created_at, updated_at)
      VALUES
        ('conv_legacy', 'onebot', 'bot', 'private:legacy', 'private', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO runs
        (id, conversation_id, prompt, state, agent, output, created_at, updated_at)
      VALUES
        ('run_legacy', 'conv_legacy', 'legacy', 'running', 'codex', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO subagent_tasks
        (id, parent_run_id, prompt, status, result, created_at, updated_at)
      VALUES
        ('subtask_legacy', 'run_legacy', 'legacy child', 'succeeded', 'legacy result', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO agent_messages
        (id, source_run_id, source_bot_id, target_bot_id, prompt, hop_count, status, created_at, updated_at)
      VALUES
        ('agentmsg_legacy', 'run_legacy', 'coder', 'reviewer', 'legacy message', 1, 'succeeded', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();

    const db = new FinalBotDatabase(path);
    try {
      expect(db.getSubagentTask("subtask_legacy")).toMatchObject({
        status: "succeeded",
        result: "legacy result",
        deadlineAt: expect.any(String),
      });
      expect(db.getAgentMessage("agentmsg_legacy")).toMatchObject({
        rootRunId: "run_legacy",
        dedupeKey: expect.any(String),
        hopCount: 1,
        status: "succeeded",
      });
    } finally {
      db.close();
    }
  });

  test("persists Sub Agent lifecycle and enforces per-parent limits", async () => {
    const db = await createDatabase();
    try {
      const conversation = db.upsertConversation({
        channel: "onebot",
        accountId: "bot",
        externalId: "private:orchestration",
        conversationKind: "private",
      });
      const parent = db.createRun({
        conversationId: conversation.id,
        prompt: "parent",
        requestedBy: "10001",
        botId: "coder",
        botName: "Coder",
        agent: "codex",
      });
      db.updateRun(parent.id, { state: "running", workspacePath: "/tmp/parent" });

      const first = db.createSubagentTask({
        parentRunId: parent.id,
        botId: "coder",
        prompt: "first child",
        deadlineAt: "2026-10-28T10:10:00.000Z",
        maxConcurrent: 1,
        maxTotal: 8,
      });
      expect(first).toMatchObject({
        parentRunId: parent.id,
        botId: "coder",
        status: "queued",
        result: null,
      });
      expect(() =>
        db.createSubagentTask({
          parentRunId: parent.id,
          botId: "coder",
          prompt: "too many active",
          deadlineAt: "2026-10-28T10:10:00.000Z",
          maxConcurrent: 1,
          maxTotal: 8,
        }),
      ).toThrow("concurrency limit");

      const child = db.createRun({
        conversationId: conversation.id,
        prompt: "first child",
        botId: "coder",
        botName: "Coder",
        agent: "codex",
        trigger: "subagent",
        parentRunId: parent.id,
      });
      const finished = db.updateSubagentTask(first.id, {
        childRunId: child.id,
        status: "succeeded",
        result: { summary: "done" },
        startedAt: "2026-10-28T10:00:00.000Z",
        finishedAt: "2026-10-28T10:01:00.000Z",
      });
      expect(finished).toMatchObject({
        childRunId: child.id,
        status: "succeeded",
        result: { summary: "done" },
      });
      expect(db.listSubagentTasks(parent.id)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("persists Cross-Bot hops with duplicate, hop, and fan-out protection", async () => {
    const db = await createDatabase();
    try {
      const conversation = db.upsertConversation({
        channel: "onebot",
        accountId: "bot",
        externalId: "private:cross-bot",
        conversationKind: "private",
      });
      const source = db.createRun({
        conversationId: conversation.id,
        prompt: "source",
        botId: "coder",
        botName: "Coder",
        agent: "codex",
      });
      db.updateRun(source.id, { state: "running" });
      const inputs = {
        sourceRunId: source.id,
        rootRunId: source.id,
        sourceBotId: "coder",
        targetBotId: "reviewer",
        prompt: "review this",
        hopCount: 1,
        maxHops: 3,
        maxPerParent: 1,
      };
      const message = db.createAgentMessage({
        ...inputs,
        dedupeKey: "dedupe-1",
      });
      expect(message).toMatchObject({
        sourceRunId: source.id,
        rootRunId: source.id,
        hopCount: 1,
        status: "queued",
      });
      expect(() => db.createAgentMessage({ ...inputs, dedupeKey: "dedupe-1" })).toThrow(
        "Duplicate",
      );
      expect(() =>
        db.createAgentMessage({
          ...inputs,
          prompt: "different",
          dedupeKey: "dedupe-2",
        }),
      ).toThrow("dispatch limit");

      const target = db.createRun({
        conversationId: conversation.id,
        prompt: "review this",
        botId: "reviewer",
        botName: "Reviewer",
        agent: "codex",
        trigger: "agent-message",
        parentRunId: source.id,
      });
      const running = db.updateAgentMessage(message.id, {
        targetRunId: target.id,
        status: "running",
        startedAt: "2026-10-28T10:00:00.000Z",
      });
      expect(running.targetRunId).toBe(target.id);
      expect(db.findAgentMessageByTargetRunId(target.id)?.id).toBe(message.id);

      expect(() =>
        db.createAgentMessage({
          ...inputs,
          sourceRunId: "other-source",
          prompt: "too deep",
          hopCount: 4,
          dedupeKey: "dedupe-hop",
        }),
      ).toThrow("hop limit");
    } finally {
      db.close();
    }
  });

  test("marks unfinished orchestration work failed after restart", async () => {
    const db = await createDatabase();
    try {
      const conversation = db.upsertConversation({
        channel: "onebot",
        accountId: "bot",
        externalId: "private:orchestration-recovery",
        conversationKind: "private",
      });
      const parent = db.createRun({
        conversationId: conversation.id,
        prompt: "parent",
        botId: "coder",
        botName: "Coder",
        agent: "codex",
      });
      db.updateRun(parent.id, { state: "running", workspacePath: "/tmp/parent" });
      const task = db.createSubagentTask({
        parentRunId: parent.id,
        botId: "coder",
        prompt: "child",
        deadlineAt: "2026-10-28T10:10:00.000Z",
        maxConcurrent: 3,
        maxTotal: 8,
      });
      const message = db.createAgentMessage({
        sourceRunId: parent.id,
        rootRunId: parent.id,
        sourceBotId: "coder",
        targetBotId: "reviewer",
        prompt: "handoff",
        hopCount: 1,
        dedupeKey: "recovery-dedupe",
        maxHops: 3,
        maxPerParent: 5,
      });

      expect(db.recoverOrchestrationAfterRestart()).toEqual({
        subagentTasks: 1,
        agentMessages: 1,
      });
      expect(db.getSubagentTask(task.id)).toMatchObject({
        status: "failed",
        error: expect.stringContaining("restarted"),
      });
      expect(db.getAgentMessage(message.id)).toMatchObject({
        status: "failed",
        error: expect.stringContaining("restarted"),
      });
    } finally {
      db.close();
    }
  });
});

describe("discuss persistence", () => {
  test("closes an open batch once and records a single superseded decision", async () => {
    const db = await createDatabase();
    try {
      const conversation = db.upsertConversation({
        channel: "onebot",
        accountId: "bot",
        externalId: "group:discuss",
        conversationKind: "group",
      });
      const stored = db.insertMessage({
        conversationId: conversation.id,
        channelId: "onebot",
        accountId: "bot",
        externalConversationId: "group:discuss",
        externalMessageId: "discuss-message",
        role: "user",
        senderId: "member",
        text: "ambient message",
      }).message;
      const batch = db.openDiscussBatch({
        conversationId: conversation.id,
        botId: "coder",
        messageId: stored.id,
        debounceMs: 0,
        maxWaitMs: 15_000,
      });

      db.closeOpenDiscussBatch(conversation.id, "coder", "superseded_by_explicit_call");
      db.closeOpenDiscussBatch(conversation.id, "coder", "superseded_by_explicit_call");

      expect(db.listDiscussBatches(conversation.id)).toContainEqual({
        ...batch,
        status: "processed",
        processedAt: expect.any(String),
      });
      expect(db.listDiscussDecisions(conversation.id)).toEqual([
        expect.objectContaining({
          conversationId: conversation.id,
          botId: "coder",
          action: "silent",
          reason: "superseded_by_explicit_call",
          messageIds: [stored.id],
        }),
      ]);
    } finally {
      db.close();
    }
  });
});

describe("plugin persistence", () => {
  test("migrates a v3 database to plugin tables with a backup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "finalbot-db-plugin-migration-"));
    tempDirs.push(dir);
    const path = join(dir, "v3.sqlite");
    const legacy = new Database(path, { create: true, readwrite: true });
    legacy.exec(`
      CREATE TABLE legacy_marker (id TEXT PRIMARY KEY);
      PRAGMA user_version = 3;
    `);
    legacy.close();

    const db = new FinalBotDatabase(path);
    try {
      expect(db.db.query("PRAGMA user_version").get()).toEqual({ user_version: 4 });
      expect(
        db.db
          .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get("plugins"),
      ).not.toBeNull();
      expect(
        db.db
          .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get("plugin_tool_policies"),
      ).not.toBeNull();
      expect(
        (await readdir(dir)).some((name) => name.includes(".v3.") && name.endsWith(".bak")),
      ).toBe(true);
    } finally {
      db.close();
    }
  });

  test("tracks discovery, enablement, status, and tool policies", async () => {
    const db = await createDatabase();
    try {
      const discovered = db.upsertDiscoveredPlugin({
        id: "demo",
        name: "Demo",
        version: "1.0.0",
        description: "Demo plugin",
        author: "FinalBot",
        entryPath: "D:/data/plugins/demo/index.js",
        manifest: {
          apiVersion: 1,
          permissions: ["tools"],
          tools: ["echo"],
        },
      });
      expect(discovered).toMatchObject({
        id: "demo",
        enabled: false,
        status: "disabled",
        lastError: null,
      });

      const enabled = db.setPluginEnabled("demo", true);
      expect(enabled).toMatchObject({ enabled: true, status: "loading" });
      db.updatePluginStatus("demo", "active");
      db.setPluginToolPolicy("demo", "echo", "auto");

      expect(db.getPlugin("demo")).toMatchObject({
        enabled: true,
        status: "active",
        lastError: null,
      });
      expect(db.getPluginToolPolicy("demo", "echo")).toBe("auto");
      expect(db.listPluginToolPolicies("demo")).toEqual([
        { pluginId: "demo", toolName: "echo", policy: "auto" },
      ]);
    } finally {
      db.close();
    }
  });

  test("preserves invalid manifest errors during discovery", async () => {
    const db = await createDatabase();
    try {
      const record = db.upsertDiscoveredPlugin({
        id: "broken",
        name: "broken",
        version: "unknown",
        description: "Broken plugin",
        entryPath: "D:/data/plugins/broken/metadata.json",
        manifest: {},
        error: "apiVersion is required",
      });
      expect(record).toMatchObject({
        enabled: false,
        status: "error",
        lastError: "apiVersion is required",
      });
    } finally {
      db.close();
    }
  });
});
