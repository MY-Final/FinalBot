import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, AgentRunResult } from "@finalbot/core";
import { FinalBotDatabase } from "@finalbot/db";
import { DiscussService } from "./discuss";
import { MemoryService } from "./memory";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("discuss gate", () => {
  test("recovers a dispatched batch idempotently when the process stopped before persistence", async () => {
    const db = await createDb();
    try {
      const conversation = await seedConversation(db);
      const message = db.insertMessage({
        conversationId: conversation.id,
        channelId: "qq",
        accountId: "app",
        externalConversationId: "group:1",
        externalMessageId: "message-1",
        role: "user",
        senderId: "member-1",
        text: "Can someone review this?",
      }).message;
      const batch = db.openDiscussBatch({
        conversationId: conversation.id,
        botId: "coder",
        messageId: message.id,
        debounceMs: 0,
        maxWaitMs: 1_000,
      });
      const existing = db.createRun({
        conversationId: conversation.id,
        prompt: message.text,
        requestedBy: message.senderId,
        botId: "coder",
        botName: "Coder",
        agent: "codex",
        trigger: "discuss",
        dispatchKey: `discuss:${batch.id}`,
      });
      db.linkRunMessages(existing.id, [message.id]);

      let dispatchCount = 0;
      const agent = new StaticDecisionAgent("send");
      const service = new DiscussService({
        db,
        agent,
        memory: new MemoryService(db),
        debounceMs: 0,
      });
      await service.recover(async () => {
        dispatchCount += 1;
        return existing.id;
      });

      expect(dispatchCount).toBe(1);
      expect(agent.calls).toBe(1);
      expect(db.listRuns()).toHaveLength(1);
      expect(db.listDiscussDecisions(conversation.id)).toEqual([
        expect.objectContaining({
          action: "send",
          runId: existing.id,
          messageIds: [message.id],
        }),
      ]);
      expect(db.getDiscussDecisionForBatch(batch.id)?.runId).toBe(existing.id);

      await service.recover(async () => {
        dispatchCount += 1;
        return existing.id;
      });
      expect(dispatchCount).toBe(1);
      expect(agent.calls).toBe(1);
    } finally {
      db.close();
    }
  });

  test("persists silent decisions without creating a Run", async () => {
    const db = await createDb();
    try {
      const conversation = await seedConversation(db);
      const message = db.insertMessage({
        conversationId: conversation.id,
        channelId: "qq",
        accountId: "app",
        externalConversationId: "group:1",
        externalMessageId: "message-2",
        role: "user",
        senderId: "member-1",
        text: "Just chatting",
      }).message;
      const batch = db.openDiscussBatch({
        conversationId: conversation.id,
        botId: "coder",
        messageId: message.id,
        debounceMs: 0,
        maxWaitMs: 1_000,
      });
      const service = new DiscussService({
        db,
        agent: new StaticDecisionAgent("silent"),
        memory: new MemoryService(db),
        debounceMs: 0,
      });
      await service.tick(async () => {
        throw new Error("silent decisions must not dispatch");
      });

      expect(db.listRuns()).toHaveLength(0);
      expect(db.getDiscussDecisionForBatch(batch.id)).toMatchObject({
        action: "silent",
        runId: null,
        messageIds: [message.id],
      });
    } finally {
      db.close();
    }
  });
});

class StaticDecisionAgent implements AgentAdapter {
  calls = 0;

  constructor(private readonly action: "send" | "silent") {}

  start(): ReturnType<AgentAdapter["start"]> {
    this.calls += 1;
    const result: AgentRunResult = {
      status: "succeeded",
      nativeThreadId: "discuss-thread",
      nativeTurnId: "discuss-turn",
      output: JSON.stringify({
        action: this.action,
        reason: "test decision",
        confidence: 0.9,
      }),
      structuredOutput: {
        action: this.action,
        reason: "test decision",
        confidence: 0.9,
      },
    };
    return {
      result: Promise.resolve(result),
      interrupt: async () => undefined,
    };
  }
}

async function createDb(): Promise<FinalBotDatabase> {
  const dir = await mkdtemp(join(tmpdir(), "finalbot-discuss-"));
  dirs.push(dir);
  return new FinalBotDatabase(join(dir, "test.sqlite"));
}

async function seedConversation(db: FinalBotDatabase) {
  return db.upsertConversation({
    channel: "qq",
    accountId: "app",
    externalId: "group:1",
    conversationKind: "group",
    metadata: {
      replyAddress: {
        channelId: "qq",
        accountId: "app",
        data: { kind: "group", targetId: "group-1" },
      },
    },
  });
}
