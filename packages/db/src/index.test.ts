import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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
        (id, conversation_id, prompt, state, agent, output, error, created_at, updated_at)
      VALUES
        ('run_old', 'conv_old', 'task', 'failed', 'codex', '', 'err', '2026-01-01', '2026-01-01');
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
      });
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
