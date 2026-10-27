import { Database } from "bun:sqlite";
import {
  type ApprovalDecision,
  assertRunTransition,
  type ChannelKind,
  type ConversationKind,
  createId,
  nowIso,
  type RunState,
} from "@finalbot/core";

export interface ConversationRecord {
  id: string;
  channel: ChannelKind;
  accountId: string;
  externalId: string;
  conversationKind: ConversationKind;
  title: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface InboxRecord {
  id: string;
  conversationId: string;
  externalMessageId: string;
  senderId: string;
  text: string;
  raw: unknown;
  status: "pending" | "running" | "done" | "failed";
  receivedAt: string;
  createdAt: string;
}

export interface RunRecord {
  id: string;
  conversationId: string;
  prompt: string;
  state: RunState;
  agent: string;
  nativeThreadId: string | null;
  nativeTurnId: string | null;
  workspacePath: string | null;
  output: string;
  error: string | null;
  replyTarget: Record<string, unknown> | null;
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
  payload: unknown;
  status: "pending" | "accepted" | "declined" | "cancelled" | "expired";
  createdAt: string;
  resolvedAt: string | null;
}

interface Row {
  [key: string]: unknown;
}

const ACTIVE_STATES: RunState[] = [
  "admitted",
  "running",
  "waiting_approval",
  "retrying",
  "interrupted",
];

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
    senderId: asString(row.sender_id),
    text: asString(row.text),
    raw: parseJson<unknown>(row.raw_json, null),
    status: asString(row.status) as InboxRecord["status"],
    receivedAt: asString(row.received_at),
    createdAt: asString(row.created_at),
  };
}

function mapRun(row: Row): RunRecord {
  return {
    id: asString(row.id),
    conversationId: asString(row.conversation_id),
    prompt: asString(row.prompt),
    state: asString(row.state) as RunState,
    agent: asString(row.agent),
    nativeThreadId: asNullableString(row.native_thread_id),
    nativeTurnId: asNullableString(row.native_turn_id),
    workspacePath: asNullableString(row.workspace_path),
    output: asString(row.output),
    error: asNullableString(row.error),
    replyTarget: parseJson<Record<string, unknown> | null>(row.reply_target_json, null),
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
    payload: parseJson<unknown>(row.payload_json, null),
    status: asString(row.status) as ApprovalRecord["status"],
    createdAt: asString(row.created_at),
    resolvedAt: asNullableString(row.resolved_at),
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
      CREATE TABLE IF NOT EXISTS conversations (
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

      CREATE TABLE IF NOT EXISTS inbox_items (
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

      CREATE TABLE IF NOT EXISTS conversation_cursors (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        last_inbox_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
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
    `);
  }

  close(): void {
    this.db.close();
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
           SET conversation_kind = ?, title = ?, metadata_json = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.conversationKind,
          input.title ?? existing.title,
          JSON.stringify(input.metadata ?? existing.metadata),
          now,
          existing.id,
        );
      return {
        ...existing,
        conversationKind: input.conversationKind,
        title: input.title ?? existing.title,
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
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .query(
        `INSERT INTO conversations
          (id, channel, account_id, external_id, conversation_kind, title, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.channel,
        record.accountId,
        record.externalId,
        record.conversationKind,
        record.title,
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
  ): { nativeThreadId: string | null } | null {
    const row = this.db
      .query(
        `SELECT native_thread_id FROM runs
         WHERE conversation_id = ? AND native_thread_id IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(conversationId) as Row | null;
    return row ? { nativeThreadId: asNullableString(row.native_thread_id) } : null;
  }

  admitInbound(input: {
    conversationId: string;
    externalMessageId: string;
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
      senderId: input.senderId,
      text: input.text,
      raw: input.raw,
      status: "pending",
      receivedAt: input.receivedAt,
      createdAt: now,
    };
    this.db
      .query(
        `INSERT INTO inbox_items
          (id, conversation_id, external_message_id, sender_id, text, raw_json, status, received_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        item.id,
        item.conversationId,
        item.externalMessageId,
        item.senderId,
        item.text,
        JSON.stringify(item.raw),
        item.receivedAt,
        item.createdAt,
      );
    return { item, duplicate: false };
  }

  getPendingInbox(conversationId: string): InboxRecord[] {
    const rows = this.db
      .query(
        `SELECT * FROM inbox_items
         WHERE conversation_id = ? AND status = 'pending'
         ORDER BY received_at ASC, created_at ASC`,
      )
      .all(conversationId) as Row[];
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

  createRun(input: {
    conversationId: string;
    prompt: string;
    agent: string;
    replyTarget?: Record<string, unknown> | null;
  }): RunRecord {
    const now = nowIso();
    const record: RunRecord = {
      id: createId("run"),
      conversationId: input.conversationId,
      prompt: input.prompt,
      state: "admitted",
      agent: input.agent,
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
          (id, conversation_id, prompt, state, agent, native_thread_id, native_turn_id,
           workspace_path, output, error, reply_target_json, created_at, updated_at, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, '', NULL, ?, ?, ?, NULL, NULL)`,
      )
      .run(
        record.id,
        record.conversationId,
        record.prompt,
        record.state,
        record.agent,
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
    payload: unknown;
  }): ApprovalRecord {
    const now = nowIso();
    this.db
      .query(
        `INSERT INTO approval_requests
          (request_id, run_id, kind, title, detail, payload_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
         ON CONFLICT(request_id) DO NOTHING`,
      )
      .run(
        input.requestId,
        input.runId,
        input.kind,
        input.title,
        input.detail,
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

  pendingOutbox(): Array<{ id: string; type: string; payload: unknown }> {
    const rows = this.db
      .query("SELECT * FROM outbox_events WHERE status = 'pending' ORDER BY created_at ASC")
      .all() as Row[];
    return rows.map((row) => ({
      id: asString(row.id),
      type: asString(row.type),
      payload: parseJson<unknown>(row.payload_json, null),
    }));
  }

  markOutboxDelivered(id: string): void {
    this.db
      .query("UPDATE outbox_events SET status = 'delivered', delivered_at = ? WHERE id = ?")
      .run(nowIso(), id);
  }
}
