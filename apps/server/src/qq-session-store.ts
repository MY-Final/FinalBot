import type { QqSession, QqSessionStore } from "@finalbot/channel-qq";
import type { FinalBotDatabase } from "@finalbot/db";

export class SqliteQqSessionStore implements QqSessionStore {
  constructor(private readonly db: FinalBotDatabase) {}

  load(accountId: string): QqSession | null {
    const record = this.db.getChannelSession("qq", accountId);
    return record ? { sessionId: record.sessionId, lastSeq: record.lastSeq } : null;
  }

  save(accountId: string, session: QqSession): void {
    this.db.saveChannelSession({
      channelId: "qq",
      accountId,
      sessionId: session.sessionId,
      lastSeq: session.lastSeq,
    });
  }

  clear(accountId: string): void {
    this.db.clearChannelSession("qq", accountId);
  }
}
