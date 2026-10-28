import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscussService } from "@finalbot/agent-runtime";
import {
  type ChannelAdapter,
  ChannelRegistry,
  type ChannelState,
  type InboundEnvelope,
  type OutboundAddress,
  type OutboundMessage,
  type SendResult,
} from "@finalbot/core";
import { FinalBotDatabase } from "@finalbot/db";
import { ChannelGateway } from "./channel-gateway";
import { OwnerService } from "./owner-service";
import type { RunService } from "./run-service";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("channel gateway routing", () => {
  test("pairs the Owner, blocks non-owner runs, and batches only ambient messages", async () => {
    const dir = await mkdtemp(join(tmpdir(), "finalbot-gateway-"));
    dirs.push(dir);
    const db = new FinalBotDatabase(join(dir, "test.sqlite"));
    try {
      const owner = new OwnerService(db);
      const channels = new ChannelRegistry();
      const adapter = new TestChannelAdapter();
      channels.register(adapter, () => undefined);
      const admitted: InboundEnvelope[] = [];
      const runs = {
        async admitInbound(message: InboundEnvelope) {
          admitted.push(message);
        },
      } as unknown as RunService;
      const enqueued: Array<{ conversationId: string; botId: string; messageId: string }> = [];
      const explicitCalls: Array<{ conversationId: string; botId: string }> = [];
      const discuss = {
        enqueue(input: { conversationId: string; botId: string; messageId: string }) {
          enqueued.push(input);
          return input;
        },
        noteExplicitCall(conversationId: string, botId: string) {
          explicitCalls.push({ conversationId, botId });
        },
      } as unknown as DiscussService;
      const gateway = new ChannelGateway({ db, channels, owner, runs, discuss });

      const pairing = owner.createPairingCode();
      await gateway.accept(
        adapter,
        envelope({
          externalConversationId: "c2c:owner-private",
          externalMessageId: "pair-1",
          senderId: "owner-private",
          senderAliases: ["owner-union"],
          text: `/pair ${pairing.code}`,
        }),
      );
      expect(adapter.sent[0]?.message.text).toContain("配对成功");

      await gateway.accept(
        adapter,
        envelope({
          externalConversationId: "group:1",
          externalMessageId: "owner-group",
          senderId: "owner-group",
          senderAliases: ["owner-union"],
          text: "@FinalBot review this",
          botMentioned: true,
          conversationKind: "group",
        }),
      );
      expect(admitted).toHaveLength(1);
      expect(explicitCalls).toHaveLength(1);

      const ambient = envelope({
        externalConversationId: "group:1",
        externalMessageId: "ambient-1",
        senderId: "member-1",
        text: "Does anyone know why tests fail?",
        conversationKind: "group",
      });
      await gateway.accept(adapter, ambient);
      expect(admitted).toHaveLength(1);
      expect(enqueued).toHaveLength(0);

      const conversation = db.upsertConversation({
        channel: "qq",
        accountId: "app",
        externalId: "group:1",
        conversationKind: "group",
      });
      db.setConversationPolicy({
        conversationId: conversation.id,
        observeAll: true,
        discussEnabled: true,
      });
      await gateway.accept(adapter, ambient);
      await gateway.accept(adapter, {
        ...ambient,
        externalMessageId: "ambient-2",
        text: "I can reproduce it on Windows.",
      });
      await gateway.accept(adapter, {
        ...ambient,
        externalMessageId: "member-mention",
        text: "@FinalBot run everything",
        botMentioned: true,
      });
      expect(admitted).toHaveLength(1);
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]).toMatchObject({
        conversationId: conversation.id,
        botId: "coder",
      });
      expect(db.listMessages(conversation.id, 20).map((message) => message.text)).toContain(
        "Does anyone know why tests fail?",
      );
    } finally {
      db.close();
    }
  });
});

class TestChannelAdapter implements ChannelAdapter {
  readonly id = "qq";
  readonly sent: Array<{ address: OutboundAddress; message: OutboundMessage }> = [];

  start(): Promise<void> {
    return Promise.resolve();
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }

  getState(): ChannelState {
    return {
      id: this.id,
      type: "qq",
      enabled: true,
      configured: true,
      connected: true,
      accountId: "app",
      capabilities: {
        observeAll: false,
        proactiveSend: false,
        reply: true,
        markdown: true,
        maxTextLength: 2_000,
        maxRepliesPerInbound: 5,
      },
      lastError: null,
    };
  }

  send(address: OutboundAddress, message: OutboundMessage): Promise<SendResult> {
    this.sent.push({ address, message });
    return Promise.resolve({ deliveredAt: new Date().toISOString() });
  }
}

function envelope(input: {
  externalConversationId: string;
  externalMessageId: string;
  senderId: string;
  text: string;
  conversationKind?: "private" | "group";
  senderAliases?: string[];
  botMentioned?: boolean;
}): InboundEnvelope {
  const conversationKind = input.conversationKind ?? "private";
  return {
    channelId: "qq",
    accountId: "app",
    externalConversationId: input.externalConversationId,
    conversationKind,
    externalMessageId: input.externalMessageId,
    senderId: input.senderId,
    ...(input.senderAliases ? { senderAliases: input.senderAliases } : {}),
    text: input.text,
    mentions: [],
    botMentioned: input.botMentioned ?? false,
    botRepliedTo: false,
    receivedAt: new Date().toISOString(),
    replyAddress: {
      channelId: "qq",
      accountId: "app",
      data:
        conversationKind === "group"
          ? { kind: "group", targetId: "1", replyToExternalMessageId: input.externalMessageId }
          : {
              kind: "c2c",
              targetId: input.senderId,
              replyToExternalMessageId: input.externalMessageId,
            },
    },
    raw: {},
  };
}
