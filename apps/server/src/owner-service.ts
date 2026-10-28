import { createHash, randomBytes } from "node:crypto";
import type { InboundEnvelope } from "@finalbot/core";
import { parseImCommand } from "@finalbot/core";
import type { FinalBotDatabase, OwnerIdentityRecord, OwnerRecord } from "@finalbot/db";

export class OwnerService {
  private readonly owner: OwnerRecord;

  constructor(private readonly db: FinalBotDatabase) {
    this.owner = db.ensureOwner();
  }

  get ownerId(): string {
    return this.owner.id;
  }

  createPairingCode(): { code: string; expiresAt: string } {
    const code = randomBytes(8).toString("base64url");
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    this.db.createOwnerPairingCode({
      codeHash: hashCode(code),
      ownerId: this.owner.id,
      expiresAt,
    });
    return { code, expiresAt };
  }

  isOwner(message: InboundEnvelope): boolean {
    return this.identity(message) !== null;
  }

  identity(message: InboundEnvelope): OwnerIdentityRecord | null {
    return this.db.resolveOwnerIdentity({
      channelId: message.channelId,
      accountId: message.accountId,
      senderId: message.senderId,
      conversationKind: message.conversationKind,
      aliases: message.senderAliases ?? [],
    });
  }

  pairFromMessage(message: InboundEnvelope): {
    ok: boolean;
    message: string;
    identity?: OwnerIdentityRecord;
  } | null {
    const command = parseImCommand(message.text);
    if (command?.kind !== "pair") return null;
    if (message.conversationKind !== "private") {
      return {
        ok: false,
        message: "配对码只能通过 Owner 私聊发送。请在私聊中重新发送 /pair。",
      };
    }
    const identity = this.db.redeemOwnerPairingCode({
      codeHash: hashCode(command.code),
      channelId: message.channelId,
      accountId: message.accountId,
      senderId: message.senderId,
      conversationKind: message.conversationKind,
      displayName: message.senderName ?? null,
      aliases: message.senderAliases ?? [],
      replyAddress: message.replyAddress,
    });
    if (!identity) {
      return {
        ok: false,
        message: "配对码无效或已过期。请在 Web 控制台生成新的 10 分钟配对码。",
      };
    }
    return { ok: true, message: "Owner 配对成功。现在可以通过这个身份触发 FinalBot。", identity };
  }
}

function hashCode(code: string): string {
  return createHash("sha256").update(code.trim()).digest("hex");
}
