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
