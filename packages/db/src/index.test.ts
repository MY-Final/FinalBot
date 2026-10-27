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
