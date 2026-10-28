import { Database } from "bun:sqlite";
import {
  type ApprovalDecision,
  assertRunTransition,
  type ChannelKind,
  type ConversationKind,
  createId,
  nowIso,
  type OneBotReplyTarget,
  type RunState,
  type WebReplyTarget,
} from "@finalbot/core";

export interface ConversationRecord {
  id: string;
  channel: ChannelKind;
  accountId: string;
  externalId: string;
  conversationKind: ConversationKind;
  title: string | null;
  activeBotId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface InboxRecord {
  id: string;
  conversationId: string;
  externalMessageId: string;
  botId: string;
  senderId: string;
  text: string;
  raw: unknown;
  status: "pending" | "running" | "done" | "failed";
  error: string | null;
  receivedAt: string;
  createdAt: string;
}

export interface RunRecord {
  id: string;
  conversationId: string;
  prompt: string;
  requestedBy: string | null;
  botId: string;
  botName: string;
  botInstructions: string | null;
  state: RunState;
  agent: string;
  model: string | null;
  nativeThreadId: string | null;
  nativeTurnId: string | null;
  workspacePath: string | null;
  output: string;
  error: string | null;
  replyTarget: OneBotReplyTarget | WebReplyTarget | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface PhaseRecord {
  id: string;
  runId: string;
  phase: string;
  attempt: number;
  status: string;
  checkpoint: unknown;
  updatedAt: string;
}

export interface ApprovalRecord {
  requestId: string;
  runId: string;
  kind: string;
  title: string;
  detail: string;
  canAcceptForSession: boolean;
  payload: unknown;
  status: "pending" | "accepted" | "declined" | "cancelled" | "expired";
  createdAt: string;
  resolvedAt: string | null;
}

export interface RunEventRecord {
  seq: number;
  runId: string | null;
  type: string;
  payload: unknown;
  createdAt: string;
}

export interface BotProfileRecord {
  id: string;
  name: string;
  description: string;
  instructions: string;
  agent: string;
  model: string | null;
  workspacePath: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  [key: string]: unknown;
}

const ACTIVE_STATES: RunState[] = ["admitted", "running", "waiting_approval", "retrying"];

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function mapConversation(row: Row): ConversationRecord {
  return {
    id: asString(row.id),
    channel: asString(row.channel) as ChannelKind,
    accountId: asString(row.account_id),
    externalId: asString(row.external_id),
    conversationKind: asString(row.conversation_kind) as ConversationKind,
    title: asNullableString(row.title),
    activeBotId: asString(row.active_bot_id, "coder"),
    metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function mapInbox(row: Row): InboxRecord {
  return {
    id: asString(row.id),
    conversationId: asString(row.conversation_id),
    externalMessageId: asString(row.external_message_id),
    botId: asString(row.bot_id, "coder"),
    senderId: asString(row.sender_id),
    text: asString(row.text),
    raw: parseJson<unknown>(row.raw_json, null),
    status: asString(row.status) as InboxRecord["status"],
    error: asNullableString(row.error),
    receivedAt: asString(row.received_at),
    createdAt: asString(row.created_at),
  };
}

function mapRun(row: Row): RunRecord {
  return {
    id: asString(row.id),
    conversationId: asString(row.conversation_id),
    prompt: asString(row.prompt),
    requestedBy: asNullableString(row.requested_by),
    botId: asString(row.bot_id, "coder"),
    botName: asString(row.bot_name, "Coder"),
    botInstructions: asNullableString(row.bot_instructions),
    state: asString(row.state) as RunState,
    agent: asString(row.agent),
    model: asNullableString(row.model),
    nativeThreadId: asNullableString(row.native_thread_id),
    nativeTurnId: asNullableString(row.native_turn_id),
    workspacePath: asNullableString(row.workspace_path),
    output: asString(row.output),
    error: asNullableString(row.error),
    replyTarget: parseJson<OneBotReplyTarget | WebReplyTarget | null>(row.reply_target_json, null),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
    startedAt: asNullableString(row.started_at),
    finishedAt: asNullableString(row.finished_at),
  };
}

function mapPhase(row: Row): PhaseRecord {
  return {
    id: asString(row.id),
    runId: asString(row.run_id),
    phase: asString(row.phase),
    attempt: Number(row.attempt ?? 1),
    status: asString(row.status),
    checkpoint: parseJson<unknown>(row.checkpoint_json, null),
    updatedAt: asString(row.updated_at),
  };
}

function mapApproval(row: Row): ApprovalRecord {
  return {
    requestId: asString(row.request_id),
    runId: asString(row.run_id),
    kind: asString(row.kind),
    title: asString(row.title),
    detail: asString(row.detail),
    canAcceptForSession: Number(row.can_accept_for_session ?? 0) === 1,
    payload: parseJson<unknown>(row.payload_json, null),
    status: asString(row.status) as ApprovalRecord["status"],
    createdAt: asString(row.created_at),
    resolvedAt: asNullableString(row.resolved_at),
  };
}

function mapBot(row: Row): BotProfileRecord {
  return {
    id: asString(row.id),
    name: asString(row.name),
    description: asString(row.description),
    instructions: asString(row.instructions),
    agent: asString(row.agent),
    model: asNullableString(row.model),
    workspacePath: asNullableString(row.workspace_path),
    enabled: Number(row.enabled ?? 0) === 1,
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

export class FinalBotDatabase {
  readonly db: Database;

  constructor(readonly path: string) {
    this.db = new Database(path, { create: true, readwrite: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bot_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        instructions TEXT NOT NULL,
        agent TEXT NOT NULL,
        model TEXT,
        workspace_path TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        account_id TEXT NOT NULL,
        external_id TEXT NOT NULL,
        conversation_kind TEXT NOT NULL,
        title TEXT,
        active_bot_id TEXT NOT NULL DEFAULT 'coder',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(channel, account_id, external_id)
      );

      CREATE TABLE IF NOT EXISTS inbox_items (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        external_message_id TEXT NOT NULL,
        bot_id TEXT NOT NULL DEFAULT 'coder',
        sender_id TEXT NOT NULL,
        text TEXT NOT NULL,
        raw_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        received_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(conversation_id, external_message_id)
      );

      CREATE TABLE IF NOT EXISTS conversation_cursors (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        last_inbox_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        prompt TEXT NOT NULL,
        requested_by TEXT,
        bot_id TEXT NOT NULL DEFAULT 'coder',
        bot_name TEXT NOT NULL DEFAULT 'Coder',
        bot_instructions TEXT,
        state TEXT NOT NULL,
        agent TEXT NOT NULL,
        model TEXT,
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

      CREATE TABLE IF NOT EXISTS run_phases (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        phase TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
        checkpoint_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL,
        UNIQUE(run_id, phase, attempt)
      );

      CREATE TABLE IF NOT EXISTS approval_requests (
        request_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        can_accept_for_session INTEGER NOT NULL DEFAULT 0,
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS outbox_events (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        delivered_at TEXT
      );

      CREATE TABLE IF NOT EXISTS run_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_inbox_conversation_status
        ON inbox_items(conversation_id, status, received_at);
      CREATE INDEX IF NOT EXISTS idx_runs_conversation
        ON runs(conversation_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_state
        ON runs(state, updated_at);
      CREATE INDEX IF NOT EXISTS idx_approvals_run_status
        ON approval_requests(run_id, status);
      CREATE INDEX IF NOT EXISTS idx_outbox_status
        ON outbox_events(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_run_events_run
        ON run_events(run_id, seq);
      CREATE INDEX IF NOT EXISTS idx_run_events_created
        ON run_events(created_at);
    `);
    this.ensureColumn("runs", "requested_by", "TEXT");
    this.ensureColumn("runs", "bot_id", "TEXT NOT NULL DEFAULT 'coder'");
    this.ensureColumn("runs", "bot_name", "TEXT NOT NULL DEFAULT 'Coder'");
    this.ensureColumn("runs", "bot_instructions", "TEXT");
    this.ensureColumn("runs", "model", "TEXT");
    this.ensureColumn("conversations", "active_bot_id", "TEXT NOT NULL DEFAULT 'coder'");
    this.ensureColumn("inbox_items", "bot_id", "TEXT NOT NULL DEFAULT 'coder'");
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_inbox_conversation_bot
        ON inbox_items(conversation_id, bot_id, status, received_at);
    `);
    this.ensureColumn("approval_requests", "can_accept_for_session", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("inbox_items", "error", "TEXT");
    this.seedDefaultBot();
  }

  private ensureColumn(
    table: "runs" | "approval_requests" | "inbox_items" | "conversations",
    column: string,
    definition: string,
  ): void {
    const rows = this.db.query(`PRAGMA table_info(${table})`).all() as Row[];
    if (rows.some((row) => asString(row.name) === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private seedDefaultBot(): void {
    const now = nowIso();
    this.db
      .query(
        `INSERT INTO bot_profiles
          (id, name, description, instructions, agent, model, workspace_path, enabled, created_at, updated_at)
         VALUES ('coder', 'Coder', 'General-purpose coding and repository assistant.',
           'Act as the coding agent for this conversation. Work directly in the provided repository, inspect before changing, make focused changes, and report concrete results.', 'codex', NULL, NULL, 1, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(now, now);
  }

  close(): void {
    this.db.close();
  }

  getBotProfile(id: string): BotProfileRecord | null {
    const row = this.db
      .query("SELECT * FROM bot_profiles WHERE id = ?")
      .get(id.toLowerCase()) as Row | null;
    return row ? mapBot(row) : null;
  }

  listBotProfiles(includeDisabled = false): BotProfileRecord[] {
    const rows = this.db
      .query(
        `SELECT * FROM bot_profiles
         ${includeDisabled ? "" : "WHERE enabled = 1"}
         ORDER BY name COLLATE NOCASE ASC`,
      )
      .all() as Row[];
    return rows.map(mapBot);
  }

  upsertBotProfile(input: {
    id: string;
    name: string;
    description: string;
    instructions: string;
    agent: string;
    model?: string | null;
    workspacePath?: string | null;
    enabled?: boolean;
  }): BotProfileRecord {
    const id = input.id.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(id)) {
      throw new Error("Bot id must use lowercase letters, numbers, '-' or '_'.");
    }
    const now = nowIso();
    this.db
      .query(
        `INSERT INTO bot_profiles
          (id, name, description, instructions, agent, model, workspace_path, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           instructions = excluded.instructions,
           agent = excluded.agent,
           model = excluded.model,
           workspace_path = excluded.workspace_path,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        input.name.trim(),
        input.description.trim(),
        input.instructions.trim(),
        input.agent,
        input.model ?? null,
        input.workspacePath ?? null,
        input.enabled === false ? 0 : 1,
        now,
        now,
      );
    const record = this.getBotProfile(id);
    if (!record) throw new Error("Bot profile write failed");
    return record;
  }

  setConversationActiveBot(conversationId: string, botId: string): ConversationRecord {
    const bot = this.getBotProfile(botId);
    if (!bot?.enabled) throw new Error(`Bot is not available: ${botId}`);
    this.db
      .query("UPDATE conversations SET active_bot_id = ?, updated_at = ? WHERE id = ?")
      .run(bot.id, nowIso(), conversationId);
    const updated = this.getConversation(conversationId);
    if (!updated) throw new Error("Conversation not found after bot selection");
    return updated;
  }

  getConversationByExternal(
    channel: ChannelKind,
    accountId: string,
    externalId: string,
  ): ConversationRecord | null {
    const row = this.db
      .query(
        `SELECT * FROM conversations
         WHERE channel = ? AND account_id = ? AND external_id = ?`,
      )
      .get(channel, accountId, externalId) as Row | null;
    return row ? mapConversation(row) : null;
  }

  upsertConversation(input: {
    channel: ChannelKind;
    accountId: string;
    externalId: string;
    conversationKind: ConversationKind;
    title?: string | null;
    activeBotId?: string;
    metadata?: Record<string, unknown>;
  }): ConversationRecord {
    const existing = this.getConversationByExternal(
      input.channel,
      input.accountId,
      input.externalId,
    );
    const now = nowIso();
    if (existing) {
      this.db
        .query(
          `UPDATE conversations
           SET conversation_kind = ?, title = ?, active_bot_id = ?, metadata_json = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.conversationKind,
          input.title ?? existing.title,
          input.activeBotId ?? existing.activeBotId,
          JSON.stringify(input.metadata ?? existing.metadata),
          now,
          existing.id,
        );
      return {
        ...existing,
        conversationKind: input.conversationKind,
        title: input.title ?? existing.title,
        activeBotId: input.activeBotId ?? existing.activeBotId,
        metadata: input.metadata ?? existing.metadata,
        updatedAt: now,
      };
    }

    const record: ConversationRecord = {
      id: createId("conv"),
      channel: input.channel,
      accountId: input.accountId,
      externalId: input.externalId,
      conversationKind: input.conversationKind,
      title: input.title ?? null,
      activeBotId: input.activeBotId ?? "coder",
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .query(
        `INSERT INTO conversations
          (id, channel, account_id, external_id, conversation_kind, title, active_bot_id, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.channel,
        record.accountId,
        record.externalId,
        record.conversationKind,
        record.title,
        record.activeBotId,
        JSON.stringify(record.metadata),
        record.createdAt,
        record.updatedAt,
      );
    return record;
  }

  getConversation(id: string): ConversationRecord | null {
    const row = this.db.query("SELECT * FROM conversations WHERE id = ?").get(id) as Row | null;
    return row ? mapConversation(row) : null;
  }

  getLatestConversationSession(
    conversationId: string,
    botId: string,
  ): { nativeThreadId: string | null } | null {
    const row = this.db
      .query(
        `SELECT native_thread_id FROM runs
         WHERE conversation_id = ? AND bot_id = ? AND native_thread_id IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(conversationId, botId) as Row | null;
    return row ? { nativeThreadId: asNullableString(row.native_thread_id) } : null;
  }

  admitInbound(input: {
    conversationId: string;
    externalMessageId: string;
    botId?: string;
    senderId: string;
    text: string;
    raw: unknown;
    receivedAt: string;
  }): { item: InboxRecord; duplicate: boolean } {
    const now = nowIso();
    const existing = this.db
      .query(
        `SELECT * FROM inbox_items
         WHERE conversation_id = ? AND external_message_id = ?`,
      )
      .get(input.conversationId, input.externalMessageId) as Row | null;
    if (existing) {
      return { item: mapInbox(existing), duplicate: true };
    }

    const item: InboxRecord = {
      id: createId("inbox"),
      conversationId: input.conversationId,
      externalMessageId: input.externalMessageId,
      botId: input.botId ?? "coder",
      senderId: input.senderId,
      text: input.text,
      raw: input.raw,
      status: "pending",
      error: null,
      receivedAt: input.receivedAt,
      createdAt: now,
    };
    this.db
      .query(
        `INSERT INTO inbox_items
          (id, conversation_id, external_message_id, bot_id, sender_id, text, raw_json, status, received_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        item.id,
        item.conversationId,
        item.externalMessageId,
        item.botId,
        item.senderId,
        item.text,
        JSON.stringify(item.raw),
        item.receivedAt,
        item.createdAt,
      );
    return { item, duplicate: false };
  }

  getPendingInbox(conversationId: string, botId?: string): InboxRecord[] {
    const rows = this.db
      .query(
        `SELECT * FROM inbox_items
         WHERE conversation_id = ? AND status = 'pending' ${botId ? "AND bot_id = ?" : ""}
         ORDER BY received_at ASC, created_at ASC`,
      )
      .all(...(botId ? [conversationId, botId] : [conversationId])) as Row[];
    return rows.map(mapInbox);
  }

  markInboxRunning(ids: string[]): void {
    if (ids.length === 0) return;
    const statement = this.db.query("UPDATE inbox_items SET status = 'running' WHERE id = ?");
    for (const id of ids) statement.run(id);
  }

  markInboxDone(conversationId: string, ids: string[]): void {
    if (ids.length === 0) return;
    const now = nowIso();
    this.db.transaction(() => {
      const update = this.db.query("UPDATE inbox_items SET status = 'done' WHERE id = ?");
      for (const id of ids) update.run(id);
      const last = ids[ids.length - 1];
      if (last) {
        this.db
          .query(
            `INSERT INTO conversation_cursors (conversation_id, last_inbox_id, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(conversation_id) DO UPDATE SET
               last_inbox_id = excluded.last_inbox_id,
               updated_at = excluded.updated_at`,
          )
          .run(conversationId, last, now);
      }
    })();
  }

  markInboxFailed(ids: string[]): void {
    if (ids.length === 0) return;
    const statement = this.db.query("UPDATE inbox_items SET status = 'failed' WHERE id = ?");
    for (const id of ids) statement.run(id);
  }

  recoverInboxAfterRestart(): { failed: number; conversations: string[] } {
    const failed = this.db.transaction(() => {
      const running = this.db
        .query("SELECT id FROM inbox_items WHERE status = 'running'")
        .all() as Row[];
      const update = this.db.query(
        "UPDATE inbox_items SET status = 'failed', error = ? WHERE id = ?",
      );
      for (const row of running) {
        update.run("FinalBot restarted while this message was executing.", asString(row.id));
      }
      return running.length;
    })();
    const conversations = this.db
      .query(
        `SELECT DISTINCT conversation_id
         FROM inbox_items
         WHERE status = 'pending'
         ORDER BY created_at ASC`,
      )
      .all() as Row[];
    return {
      failed,
      conversations: conversations.map((row) => asString(row.conversation_id)),
    };
  }

  recoverQueueAfterRestart(): {
    failed: number;
    queues: Array<{ conversationId: string; botId: string }>;
  } {
    const failed = this.db.transaction(() => {
      const running = this.db
        .query("SELECT id FROM inbox_items WHERE status = 'running'")
        .all() as Row[];
      const update = this.db.query(
        "UPDATE inbox_items SET status = 'failed', error = ? WHERE id = ?",
      );
      for (const row of running) {
        update.run("FinalBot restarted while this message was executing.", asString(row.id));
      }
      return running.length;
    })();
    const queues = this.db
      .query(
        `SELECT conversation_id, bot_id
         FROM inbox_items
         WHERE status = 'pending'
         GROUP BY conversation_id, bot_id
         ORDER BY MIN(created_at) ASC`,
      )
      .all() as Row[];
    return {
      failed,
      queues: queues.map((row) => ({
        conversationId: asString(row.conversation_id),
        botId: asString(row.bot_id, "coder"),
      })),
    };
  }

  createRun(input: {
    conversationId: string;
    prompt: string;
    requestedBy?: string | null;
    botId: string;
    botName: string;
    botInstructions?: string | null;
    agent: string;
    model?: string | null;
    replyTarget?: OneBotReplyTarget | WebReplyTarget | null;
  }): RunRecord {
    const now = nowIso();
    const record: RunRecord = {
      id: createId("run"),
      conversationId: input.conversationId,
      prompt: input.prompt,
      requestedBy: input.requestedBy ?? null,
      botId: input.botId,
      botName: input.botName,
      botInstructions: input.botInstructions ?? null,
      state: "admitted",
      agent: input.agent,
      model: input.model ?? null,
      nativeThreadId: null,
      nativeTurnId: null,
      workspacePath: null,
      output: "",
      error: null,
      replyTarget: input.replyTarget ?? null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
    };
    this.db
      .query(
        `INSERT INTO runs
          (id, conversation_id, prompt, requested_by, bot_id, bot_name, bot_instructions, state, agent, model, native_thread_id, native_turn_id,
           workspace_path, output, error, reply_target_json, created_at, updated_at, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, '', NULL, ?, ?, ?, NULL, NULL)`,
      )
      .run(
        record.id,
        record.conversationId,
        record.prompt,
        record.requestedBy,
        record.botId,
        record.botName,
        record.botInstructions,
        record.state,
        record.agent,
        record.model,
        record.replyTarget ? JSON.stringify(record.replyTarget) : null,
        record.createdAt,
        record.updatedAt,
      );
    return record;
  }

  getRun(id: string): RunRecord | null {
    const row = this.db.query("SELECT * FROM runs WHERE id = ?").get(id) as Row | null;
    return row ? mapRun(row) : null;
  }

  listRuns(limit = 50): RunRecord[] {
    const rows = this.db
      .query("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?")
      .all(Math.max(1, Math.min(limit, 200))) as Row[];
    return rows.map(mapRun);
  }

  getLatestRun(conversationId: string): RunRecord | null {
    const row = this.db
      .query(
        `SELECT * FROM runs
         WHERE conversation_id = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(conversationId) as Row | null;
    return row ? mapRun(row) : null;
  }

  updateRun(
    id: string,
    input: {
      state?: RunState;
      nativeThreadId?: string | null;
      nativeTurnId?: string | null;
      workspacePath?: string | null;
      error?: string | null;
      outputAppend?: string;
      startedAt?: string | null;
      finishedAt?: string | null;
    },
  ): RunRecord {
    const current = this.getRun(id);
    if (!current) throw new Error(`Run not found: ${id}`);
    if (input.state && input.state !== current.state) {
      assertRunTransition(current.state, input.state);
    }

    const now = nowIso();
    const output =
      input.outputAppend === undefined ? current.output : `${current.output}${input.outputAppend}`;
    this.db
      .query(
        `UPDATE runs SET
          state = ?, native_thread_id = ?, native_turn_id = ?, workspace_path = ?,
          output = ?, error = ?, updated_at = ?, started_at = ?, finished_at = ?
         WHERE id = ?`,
      )
      .run(
        input.state ?? current.state,
        input.nativeThreadId === undefined ? current.nativeThreadId : input.nativeThreadId,
        input.nativeTurnId === undefined ? current.nativeTurnId : input.nativeTurnId,
        input.workspacePath === undefined ? current.workspacePath : input.workspacePath,
        output,
        input.error === undefined ? current.error : input.error,
        now,
        input.startedAt === undefined ? current.startedAt : input.startedAt,
        input.finishedAt === undefined ? current.finishedAt : input.finishedAt,
        id,
      );
    const updated = this.getRun(id);
    if (!updated) throw new Error(`Run disappeared after update: ${id}`);
    return updated;
  }

  putPhase(input: {
    runId: string;
    phase: string;
    attempt?: number;
    status: string;
    checkpoint?: unknown;
  }): PhaseRecord {
    const now = nowIso();
    const attempt = input.attempt ?? 1;
    this.db
      .query(
        `INSERT INTO run_phases
          (id, run_id, phase, attempt, status, checkpoint_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, phase, attempt) DO UPDATE SET
           status = excluded.status,
           checkpoint_json = excluded.checkpoint_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        createId("phase"),
        input.runId,
        input.phase,
        attempt,
        input.status,
        JSON.stringify(input.checkpoint ?? {}),
        now,
      );
    const row = this.db
      .query(
        `SELECT * FROM run_phases
         WHERE run_id = ? AND phase = ? AND attempt = ?`,
      )
      .get(input.runId, input.phase, attempt) as Row | null;
    if (!row) throw new Error("Phase write failed");
    return mapPhase(row);
  }

  listPhases(runId: string): PhaseRecord[] {
    const rows = this.db
      .query("SELECT * FROM run_phases WHERE run_id = ? ORDER BY updated_at ASC")
      .all(runId) as Row[];
    return rows.map(mapPhase);
  }

  createApproval(input: {
    requestId: string;
    runId: string;
    kind: string;
    title: string;
    detail: string;
    canAcceptForSession: boolean;
    payload: unknown;
  }): ApprovalRecord {
    const now = nowIso();
    this.db
      .query(
        `INSERT INTO approval_requests
          (request_id, run_id, kind, title, detail, can_accept_for_session, payload_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
         ON CONFLICT(request_id) DO NOTHING`,
      )
      .run(
        input.requestId,
        input.runId,
        input.kind,
        input.title,
        input.detail,
        input.canAcceptForSession ? 1 : 0,
        JSON.stringify(input.payload),
        now,
      );
    const row = this.db
      .query("SELECT * FROM approval_requests WHERE request_id = ?")
      .get(input.requestId) as Row | null;
    if (!row) throw new Error("Approval write failed");
    return mapApproval(row);
  }

  getApproval(requestId: string): ApprovalRecord | null {
    const row = this.db
      .query("SELECT * FROM approval_requests WHERE request_id = ?")
      .get(requestId) as Row | null;
    return row ? mapApproval(row) : null;
  }

  listApprovals(runId: string): ApprovalRecord[] {
    const rows = this.db
      .query("SELECT * FROM approval_requests WHERE run_id = ? ORDER BY created_at ASC")
      .all(runId) as Row[];
    return rows.map(mapApproval);
  }

  listPendingApprovals(runId: string): ApprovalRecord[] {
    const rows = this.db
      .query(
        `SELECT * FROM approval_requests
         WHERE run_id = ? AND status = 'pending'
         ORDER BY created_at ASC`,
      )
      .all(runId) as Row[];
    return rows.map(mapApproval);
  }

  resolveApproval(requestId: string, decision: ApprovalDecision): ApprovalRecord {
    const current = this.getApproval(requestId);
    if (!current) throw new Error(`Approval not found: ${requestId}`);
    if (current.status !== "pending") return current;
    const status =
      decision.action === "decline"
        ? "declined"
        : decision.action === "cancel"
          ? "cancelled"
          : "accepted";
    this.db
      .query("UPDATE approval_requests SET status = ?, resolved_at = ? WHERE request_id = ?")
      .run(status, nowIso(), requestId);
    const updated = this.getApproval(requestId);
    if (!updated) throw new Error("Approval disappeared after update");
    return updated;
  }

  countActiveRuns(): number {
    const row = this.db
      .query(
        `SELECT COUNT(*) AS count FROM runs
         WHERE state IN ('admitted', 'running', 'waiting_approval', 'retrying')`,
      )
      .get() as Row | null;
    return Number(row?.count ?? 0);
  }

  recoverActiveRuns(): RunRecord[] {
    const rows = this.db
      .query(
        `SELECT * FROM runs
         WHERE state IN ('admitted', 'running', 'waiting_approval', 'retrying')
         ORDER BY created_at ASC`,
      )
      .all() as Row[];
    const recovered: RunRecord[] = [];
    for (const row of rows) {
      const run = mapRun(row);
      const nextState: RunState = "interrupted";
      if (ACTIVE_STATES.includes(run.state)) {
        this.db
          .query(
            `UPDATE runs
             SET state = ?, error = COALESCE(error, ?), updated_at = ?, finished_at = ?
             WHERE id = ?`,
          )
          .run(
            nextState,
            "FinalBot restarted before this run reached a terminal state.",
            nowIso(),
            nowIso(),
            run.id,
          );
        this.putPhase({
          runId: run.id,
          phase: "recovery",
          status: "interrupted",
          checkpoint: { previousState: run.state, reason: "process_restart" },
        });
        this.expirePendingApprovals(run.id);
        const updated = this.getRun(run.id);
        if (updated) recovered.push(updated);
      }
    }
    return recovered;
  }

  private expirePendingApprovals(runId: string): void {
    this.db
      .query(
        `UPDATE approval_requests
         SET status = 'expired', resolved_at = ?
         WHERE run_id = ? AND status = 'pending'`,
      )
      .run(nowIso(), runId);
  }

  appendEvent(input: { runId: string | null; type: string; payload: unknown }): RunEventRecord {
    const createdAt = nowIso();
    const result = this.db
      .query(
        `INSERT INTO run_events (run_id, type, payload_json, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(input.runId, input.type, JSON.stringify(input.payload), createdAt);
    const seq = Number(result.lastInsertRowid);
    return {
      seq,
      runId: input.runId,
      type: input.type,
      payload: input.payload,
      createdAt,
    };
  }

  listEventsAfter(after: number, limit = 2000): RunEventRecord[] {
    const rows = this.db
      .query(
        `SELECT * FROM run_events
         WHERE seq > ?
         ORDER BY seq ASC
         LIMIT ?`,
      )
      .all(after, Math.max(1, Math.min(limit, 5000))) as Row[];
    return rows.map((row) => ({
      seq: Number(row.seq),
      runId: asNullableString(row.run_id),
      type: asString(row.type),
      payload: parseJson<unknown>(row.payload_json, null),
      createdAt: asString(row.created_at),
    }));
  }

  latestEventSeq(): number {
    const row = this.db
      .query("SELECT COALESCE(MAX(seq), 0) AS seq FROM run_events")
      .get() as Row | null;
    return Number(row?.seq ?? 0);
  }

  enqueueOutbox(type: string, payload: unknown, runId: string | null = null): string {
    const id = createId("outbox");
    this.db
      .query(
        `INSERT INTO outbox_events (id, run_id, type, payload_json, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
      )
      .run(id, runId, type, JSON.stringify(payload), nowIso());
    return id;
  }

  pendingOutbox(limit = 100): Array<{
    id: string;
    runId: string | null;
    type: string;
    payload: unknown;
    createdAt: string;
  }> {
    const rows = this.db
      .query(
        `SELECT * FROM outbox_events
         WHERE status = 'pending'
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(Math.max(1, Math.min(limit, 1000))) as Row[];
    return rows.map((row) => ({
      id: asString(row.id),
      runId: asNullableString(row.run_id),
      type: asString(row.type),
      payload: parseJson<unknown>(row.payload_json, null),
      createdAt: asString(row.created_at),
    }));
  }

  markOutboxDelivered(id: string): void {
    this.db
      .query("UPDATE outbox_events SET status = 'delivered', delivered_at = ? WHERE id = ?")
      .run(nowIso(), id);
  }
}
