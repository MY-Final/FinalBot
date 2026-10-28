import type { DiscussService } from "@finalbot/agent-runtime";
import type {
  ChannelAdapter,
  ChannelRegistry,
  ChannelState,
  InboundEnvelope,
  OutboundAddress,
  OutboundMessage,
  SendResult,
} from "@finalbot/core";
import type { FinalBotDatabase } from "@finalbot/db";
import type { OwnerService } from "./owner-service";
import type { RunService } from "./run-service";

export interface ChannelGatewayOptions {
  db: FinalBotDatabase;
  channels: ChannelRegistry;
  owner: OwnerService;
  runs: RunService;
  discuss: DiscussService;
}

export class ChannelGateway {
  constructor(private readonly options: ChannelGatewayOptions) {}

  register(adapter: ChannelAdapter): void {
    this.options.channels.register(adapter, (message) => this.accept(adapter, message));
  }

  async accept(adapter: ChannelAdapter, message: InboundEnvelope): Promise<void> {
    const conversation = this.options.db.upsertConversation({
      channel: message.channelId,
      accountId: message.accountId,
      externalId: message.externalConversationId,
      conversationKind: message.conversationKind,
      metadata: { replyAddress: message.replyAddress },
    });
    const stored = this.options.db.insertMessage({
      conversationId: conversation.id,
      channelId: message.channelId,
      accountId: message.accountId,
      externalConversationId: message.externalConversationId,
      externalMessageId: message.externalMessageId,
      role: "user",
      senderId: message.senderId,
      senderName: message.senderName ?? null,
      text: message.text,
      raw: message.raw,
      replyAddress: message.replyAddress,
      replyToExternalMessageId: message.replyToExternalMessageId ?? null,
      metadata: {
        mentions: message.mentions,
        botMentioned: message.botMentioned,
        botRepliedTo: message.botRepliedTo,
      },
      createdAt: message.receivedAt,
    });
    if (stored.duplicate) return;

    const pairing = this.options.owner.pairFromMessage(message);
    if (pairing) {
      await this.send(adapter, message.replyAddress, pairing.message);
      return;
    }

    const isOwner = this.options.owner.isOwner(message);
    if (message.conversationKind === "private") {
      if (isOwner) await this.options.runs.admitInbound(message);
      return;
    }
    if (message.conversationKind !== "group") return;

    const policy = this.options.db.getConversationPolicy(conversation.id);
    const explicit =
      message.botMentioned || message.botRepliedTo || message.text.trim().startsWith("/");
    if (isOwner && explicit) {
      if (explicit)
        this.options.discuss.noteExplicitCall(conversation.id, conversation.activeBotId);
      await this.options.runs.admitInbound(message);
      return;
    }

    if (!policy.observeAll) return;
    if (!explicit && policy.discussEnabled) {
      this.options.discuss.enqueue({
        conversationId: conversation.id,
        botId: conversation.activeBotId,
        messageId: stored.message.id,
      });
    }
  }

  async send(
    _adapter: ChannelAdapter,
    address: OutboundAddress,
    text: string,
  ): Promise<SendResult> {
    return this.options.channels.send(address, {
      text,
      format: text.includes("\n") ? "markdown" : "text",
    });
  }

  states(): ChannelState[] {
    return this.options.channels.states();
  }

  async flushOutbox(address: OutboundAddress, message: OutboundMessage): Promise<void> {
    await this.options.channels.send(address, message);
  }
}
