import { Database } from "bun:sqlite";
import {
  type ApprovalDecision,
  assertRunTransition,
  type ChannelKind,
  type ConversationKind,
  createId,
  nowIso,
  type OutboundAddress,
  type RunState,
  type WorkspaceMode,
} from "@finalbot/core";

const DATABASE_SCHEMA_VERSION = 4;

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
  replyAddress: OutboundAddress | null;
  trigger: string;
  parentRunId: string | null;
  dispatchKey: string | null;
  workspaceMode: WorkspaceMode;
  toolRevision: number;
  toolSnapshotHash: string | null;
  toolSnapshotJson: string | null;
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
  workspaceMode: WorkspaceMode;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRecord {
  id: string;
  conversationId: string | null;
  channelId: string;
  accountId: string;
  externalConversationId: string | null;
  externalMessageId: string | null;
  role: "user" | "assistant" | "system";
  senderId: string | null;
  senderName: string | null;
  text: string;
  raw: unknown;
  replyAddress: OutboundAddress | null;
  replyToExternalMessageId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ConversationPolicyRecord {
  conversationId: string;
  observeAll: boolean;
  discussEnabled: boolean;
  updatedAt: string;
}

export interface MemoryRecord {
  id: string;
  scope: "owner" | "bot";
  botId: string | null;
  kind: string;
  content: string;
  tags: string[];
  confidence: number;
  status: "active" | "deleted";
  sourceRunId: string | null;
  sourceMessageId: string | null;
  createdAt: string;
  updatedAt: string;
  accessedAt: string;
}

export interface ScratchpadRecord {
  conversationId: string;
  botId: string;
  content: unknown;
  revision: number;
  expiresAt: string;
  updatedAt: string;
}

export interface OwnerRecord {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface OwnerIdentityRecord {
  id: string;
  ownerId: string;
  channelId: string;
  accountId: string;
  senderId: string;
  conversationKind: ConversationKind;
  displayName: string | null;
  aliases: string[];
  replyAddress: OutboundAddress | null;
  createdAt: string;
}

export interface McpServerRecord {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command: string | null;
  argsJson: string;
  url: string | null;
  envRefsJson: string;
  headersJson: string;
  enabled: boolean;
  status: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface McpToolPolicyRecord {
  serverId: string;
  toolName: string;
  policy: "auto" | "ask" | "deny";
}

export type PluginStatus = "disabled" | "loading" | "active" | "error" | "missing";

export interface PluginRecord {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string | null;
  entryPath: string;
  source: string;
  enabled: boolean;
  status: PluginStatus;
  manifest: Record<string, unknown>;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PluginToolPolicyRecord {
  pluginId: string;
  toolName: string;
  policy: "auto" | "ask" | "deny";
}

export interface ScheduleRecord {
  id: string;
  name: string;
  expression: string;
  timezone: string;
  conversationId: string;
  botId: string;
  prompt: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelSessionRecord {
  channelId: string;
  accountId: string;
  sessionId: string;
  lastSeq: number;
  updatedAt: string;
}

export interface DiscussDecisionRecord {
  id: string;
  conversationId: string;
  botId: string;
  runId: string | null;
  action: "send" | "silent";
  reason: string;
  confidence: number;
  model: string | null;
  messageIds: string[];
  createdAt: string;
}

export interface OutboxChunkRecord {
  id: string;
  outboxId: string;
  index: number;
  text: string;
  status: "pending" | "delivering" | "delivered" | "dead";
  attempts: number;
  externalMessageId: string | null;
  lastError: string | null;
}

export interface ToolCallRecord {
  id: string;
  runId: string;
  namespace: string;
  tool: string;
  arguments: unknown;
  result: unknown;
  status: "running" | "succeeded" | "failed" | "denied";
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface CodeExecutionRecord {
  id: string;
  runId: string;
  code: string;
  status: "running" | "waiting_approval" | "succeeded" | "failed" | "cancelled";
  result: unknown;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface CodeExecutionCallRecord {
  executionId: string;
  callIndex: number;
  toolPath: string;
  arguments: unknown;
  result: unknown;
  status: "succeeded" | "failed";
}

export interface DiscussBatchRecord {
  id: string;
  conversationId: string;
  botId: string;
  runId: string | null;
  status: "open" | "processing" | "processed" | "failed";
  openedAt: string;
  dueAt: string;
  hardDeadlineAt: string;
  processedAt: string | null;
}

export type SubagentTaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled";

export interface SubagentTaskRecord {
  id: string;
  parentRunId: string;
  childRunId: string | null;
  botId: string;
  prompt: string;
  status: SubagentTaskStatus;
  result: unknown;
  error: string | null;
  deadlineAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AgentMessageStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface AgentMessageRecord {
  id: string;
  sourceRunId: string;
  rootRunId: string;
  sourceBotId: string;
  targetBotId: string;
  targetRunId: string | null;
  prompt: string;
  hopCount: number;
  status: AgentMessageStatus;
  dedupeKey: string;
  result: unknown;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
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

function parseStoredResult(row: Row): unknown {
  const value = asNullableString(row.result_json) ?? asNullableString(row.result);
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeAliases(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, 16);
}

function cjkBigrams(value: string): string {
  const tokens: string[] = [];
  const groups = value.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) ?? [];
  for (const group of groups) {
    const chars = [...group];
    if (chars.length === 1) {
      tokens.push(chars[0] ?? "");
      continue;
    }
    for (let index = 0; index < chars.length - 1; index += 1) {
      tokens.push(`${chars[index]}${chars[index + 1]}`);
    }
  }
  return tokens.join(" ");
}

function toFtsQuery(value: string): string | null {
  const terms = value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .split(/\s+/)
    .map((term) => term.replace(/["*:^(){}[\]]/g, ""))
    .filter(Boolean);
  if (terms.length === 0) return null;
  return terms
    .map((term) => {
      const cjk = [...term].filter((char) => /\p{Script=Han}/u.test(char));
      if (cjk.length >= 2) {
        const grams: string[] = [];
        for (let index = 0; index < cjk.length - 1; index += 1) {
          grams.push(`"${cjk[index]}${cjk[index + 1]}"`);
        }
        return `(${grams.join(" AND ")})`;
      }
      return `"${term}"`;
    })
    .join(" AND ");
}

function legacyReplyAddress(
  value: unknown,
  channelId: string,
  accountId: string,
): OutboundAddress | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.channelId === "string" &&
    record.data &&
    typeof record.data === "object" &&
    !Array.isArray(record.data)
  ) {
    return {
      channelId: record.channelId,
      accountId: typeof record.accountId === "string" ? record.accountId : accountId,
      data: record.data as Record<string, unknown>,
    };
  }
  if (record.kind === "web") {
    return { channelId: "web", accountId: "local", data: {} };
  }
  if (record.kind === "onebot") {
    const messageType = record.messageType === "group" ? "group" : "private";
    return {
      channelId: "onebot",
      accountId,
      data: {
        messageType,
        ...(messageType === "group"
          ? { groupId: String(record.groupId ?? "") }
          : { userId: String(record.userId ?? "") }),
      },
    };
  }
  if (channelId !== "unknown") {
    return {
      channelId,
      accountId,
      data: { ...record },
    };
  }
  return null;
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
    replyAddress: parseJson<OutboundAddress | null>(row.reply_target_json, null),
    trigger: asString(row.trigger_kind, "message"),
    parentRunId: asNullableString(row.parent_run_id),
    dispatchKey: asNullableString(row.dispatch_key),
    workspaceMode: asString(row.workspace_mode, "git-worktree") as WorkspaceMode,
    toolRevision: Number(row.tool_revision ?? 0),
    toolSnapshotHash: asNullableString(row.tool_snapshot_hash),
    toolSnapshotJson: asNullableString(row.tool_snapshot_json),
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
    workspaceMode: asString(row.workspace_mode, "git-worktree") as WorkspaceMode,
    enabled: Number(row.enabled ?? 0) === 1,
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function mapMessage(row: Row): MessageRecord {
  return {
    id: asString(row.id),
    conversationId: asNullableString(row.conversation_id),
    channelId: asString(row.channel_id),
    accountId: asString(row.account_id),
    externalConversationId: asNullableString(row.external_conversation_id),
    externalMessageId: asNullableString(row.external_message_id),
    role: asString(row.role) as MessageRecord["role"],
    senderId: asNullableString(row.sender_id),
    senderName: asNullableString(row.sender_name),
    text: asString(row.text),
    raw: parseJson<unknown>(row.raw_json, null),
    replyAddress: parseJson<OutboundAddress | null>(row.reply_address_json, null),
    replyToExternalMessageId: asNullableString(row.reply_to_external_message_id),
    metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
    createdAt: asString(row.created_at),
  };
}

function mapPolicy(row: Row): ConversationPolicyRecord {
  return {
    conversationId: asString(row.conversation_id),
    observeAll: Number(row.observe_all ?? 0) === 1,
    discussEnabled: Number(row.discuss_enabled ?? 1) === 1,
    updatedAt: asString(row.updated_at),
  };
}

function mapMemory(row: Row): MemoryRecord {
  return {
    id: asString(row.id),
    scope: asString(row.scope) as MemoryRecord["scope"],
    botId: asNullableString(row.bot_id),
    kind: asString(row.kind),
    content: asString(row.content),
    tags: parseJson<string[]>(row.tags_json, []),
    confidence: Number(row.confidence ?? 1),
    status: asString(row.status) as MemoryRecord["status"],
    sourceRunId: asNullableString(row.source_run_id),
    sourceMessageId: asNullableString(row.source_message_id),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
    accessedAt: asString(row.accessed_at),
  };
}

function mapScratchpad(row: Row): ScratchpadRecord {
  return {
    conversationId: asString(row.conversation_id),
    botId: asString(row.bot_id),
    content: parseJson<unknown>(row.content_json, null),
    revision: Number(row.revision ?? 1),
    expiresAt: asString(row.expires_at),
    updatedAt: asString(row.updated_at),
  };
}

function mapCodeExecution(row: Row): CodeExecutionRecord {
  return {
    id: asString(row.id),
    runId: asString(row.run_id),
    code: asString(row.code),
    status: asString(row.status) as CodeExecutionRecord["status"],
    result: parseStoredResult(row),
    error: asNullableString(row.error),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
    finishedAt: asNullableString(row.finished_at),
  };
}

function mapOwner(row: Row): OwnerRecord {
  return {
    id: asString(row.id),
    name: asString(row.name),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function mapOwnerIdentity(row: Row): OwnerIdentityRecord {
  return {
    id: asString(row.id),
    ownerId: asString(row.owner_id),
    channelId: asString(row.channel_id),
    accountId: asString(row.account_id),
    senderId: asString(row.sender_id),
    conversationKind: asString(row.conversation_kind) as ConversationKind,
    displayName: asNullableString(row.display_name),
    aliases: parseJson<string[]>(row.aliases_json, []),
    replyAddress: parseJson<OutboundAddress | null>(row.reply_address_json, null),
    createdAt: asString(row.created_at),
  };
}

function mapDiscussBatch(row: Row): DiscussBatchRecord {
  return {
    id: asString(row.id),
    conversationId: asString(row.conversation_id),
    botId: asString(row.bot_id),
    runId: asNullableString(row.run_id),
    status: asString(row.status) as DiscussBatchRecord["status"],
    openedAt: asString(row.opened_at),
    dueAt: asString(row.due_at),
    hardDeadlineAt: asString(row.hard_deadline_at),
    processedAt: asNullableString(row.processed_at),
  };
}

function mapDiscussDecision(row: Row): DiscussDecisionRecord {
  return {
    id: asString(row.id),
    conversationId: asString(row.conversation_id),
    botId: asString(row.bot_id),
    runId: asNullableString(row.run_id),
    action: asString(row.action) as DiscussDecisionRecord["action"],
    reason: asString(row.reason),
    confidence: Number(row.confidence ?? 0),
    model: asNullableString(row.model),
    messageIds: parseJson<string[]>(row.message_ids_json, []),
    createdAt: asString(row.created_at),
  };
}

function mapSubagentTask(row: Row): SubagentTaskRecord {
  return {
    id: asString(row.id),
    parentRunId: asString(row.parent_run_id),
    childRunId: asNullableString(row.child_run_id),
    botId: asString(row.bot_id, "coder"),
    prompt: asString(row.prompt),
    status: asString(row.status) as SubagentTaskStatus,
    result: parseStoredResult(row),
    error: asNullableString(row.error),
    deadlineAt: asString(row.deadline_at),
    startedAt: asNullableString(row.started_at),
    finishedAt: asNullableString(row.finished_at),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function mapAgentMessage(row: Row): AgentMessageRecord {
  return {
    id: asString(row.id),
    sourceRunId: asString(row.source_run_id),
    rootRunId: asString(row.root_run_id, asString(row.source_run_id)),
    sourceBotId: asString(row.source_bot_id),
    targetBotId: asString(row.target_bot_id),
    targetRunId: asNullableString(row.target_run_id),
    prompt: asString(row.prompt),
    hopCount: Number(row.hop_count ?? 0),
    status: asString(row.status) as AgentMessageStatus,
    dedupeKey: asString(row.dedupe_key),
    result: parseJson<unknown>(row.result_json, null),
    error: asNullableString(row.error),
    startedAt: asNullableString(row.started_at),
    finishedAt: asNullableString(row.finished_at),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function mapMcpServer(row: Row): McpServerRecord {
  return {
    id: asString(row.id),
    name: asString(row.name),
    transport: asString(row.transport) as McpServerRecord["transport"],
    command: asNullableString(row.command),
    argsJson: asString(row.args_json, "[]"),
    url: asNullableString(row.url),
    envRefsJson: asString(row.env_refs_json, "{}"),
    headersJson: asString(row.headers_json, "{}"),
    enabled: Number(row.enabled ?? 0) === 1,
    status: asString(row.status, "disconnected"),
    lastError: asNullableString(row.last_error),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function mapPlugin(row: Row): PluginRecord {
  return {
    id: asString(row.id),
    name: asString(row.name),
    version: asString(row.version, "unknown"),
    description: asString(row.description),
    author: asNullableString(row.author),
    entryPath: asString(row.entry_path),
    source: asString(row.source, "local"),
    enabled: Number(row.enabled ?? 0) === 1,
    status: asString(row.status, "disabled") as PluginStatus,
    manifest: parseJson<Record<string, unknown>>(row.manifest_json, {}),
    lastError: asNullableString(row.last_error),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function mapSchedule(row: Row): ScheduleRecord {
  return {
    id: asString(row.id),
    name: asString(row.name),
    expression: asString(row.expression),
    timezone: asString(row.timezone, "Asia/Shanghai"),
    conversationId: asString(row.conversation_id),
    botId: asString(row.bot_id),
    prompt: asString(row.prompt),
    enabled: Number(row.enabled ?? 0) === 1,
    nextRunAt: asNullableString(row.next_run_at),
    lastRunAt: asNullableString(row.last_run_at),
    lastError: asNullableString(row.last_error),
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
    const existingSchema = this.hasUserTables();
    const schemaVersion = this.schemaVersion();
    if (existingSchema && schemaVersion < DATABASE_SCHEMA_VERSION) {
      this.backupBeforeMigration(schemaVersion);
    }
    this.db.transaction(() => {
      this.migrate();
      this.migrateLegacyReplyAddresses();
      this.migrateLegacyMessages();
      this.db.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION};`);
    })();
  }

  private hasUserTables(): boolean {
    const row = this.db
      .query(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         LIMIT 1`,
      )
      .get() as Row | null;
    return row !== null;
  }

  private schemaVersion(): number {
    const row = this.db.query("PRAGMA user_version").get() as Row | null;
    return Number(row?.user_version ?? 0);
  }

  private backupBeforeMigration(schemaVersion: number): void {
    if (this.path === ":memory:" || this.path.startsWith("file::memory:")) return;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${this.path}.v${schemaVersion}.${timestamp}.bak`;
    const escaped = backupPath.replace(/'/g, "''");
    try {
      this.db.exec(`VACUUM INTO '${escaped}';`);
    } catch (error) {
      throw new Error(
        `Failed to back up SQLite before migration to v${DATABASE_SCHEMA_VERSION}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
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
        workspace_mode TEXT NOT NULL DEFAULT 'git-worktree',
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
        workspace_mode TEXT NOT NULL DEFAULT 'git-worktree',
        trigger_kind TEXT NOT NULL DEFAULT 'message',
        parent_run_id TEXT,
        dispatch_key TEXT,
        tool_revision INTEGER NOT NULL DEFAULT 0,
        tool_snapshot_hash TEXT,
        tool_snapshot_json TEXT,
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
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        delivered_at TEXT
      );

      CREATE TABLE IF NOT EXISTS outbox_chunks (
        id TEXT PRIMARY KEY,
        outbox_id TEXT NOT NULL REFERENCES outbox_events(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        external_message_id TEXT,
        last_error TEXT,
        delivered_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(outbox_id, chunk_index)
      );

      CREATE TABLE IF NOT EXISTS run_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
        channel_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        external_conversation_id TEXT,
        external_message_id TEXT,
        role TEXT NOT NULL,
        sender_id TEXT,
        sender_name TEXT,
        text TEXT NOT NULL,
        raw_json TEXT NOT NULL DEFAULT '{}',
        reply_address_json TEXT,
        reply_to_external_message_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        UNIQUE(channel_id, account_id, external_message_id)
      );

      CREATE TABLE IF NOT EXISTS run_messages (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        PRIMARY KEY(run_id, message_id)
      );

      CREATE TABLE IF NOT EXISTS conversation_policies (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        observe_all INTEGER NOT NULL DEFAULT 0,
        discuss_enabled INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS owners (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS owner_identities (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        conversation_kind TEXT NOT NULL,
        display_name TEXT,
        aliases_json TEXT NOT NULL DEFAULT '[]',
        reply_address_json TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(channel_id, account_id, sender_id, conversation_kind)
      );

      CREATE TABLE IF NOT EXISTS owner_pairing_codes (
        code_hash TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        bot_id TEXT,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        normalized_content TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        confidence REAL NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        source_run_id TEXT,
        source_message_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        accessed_at TEXT NOT NULL,
        UNIQUE(scope, bot_id, kind, normalized_content)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        memory_id UNINDEXED,
        content,
        tags,
        cjk_tokens,
        tokenize = 'unicode61'
      );

      CREATE TABLE IF NOT EXISTS scratchpads (
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        bot_id TEXT NOT NULL,
        content_json TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(conversation_id, bot_id)
      );

      CREATE TABLE IF NOT EXISTS tool_calls (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        namespace TEXT NOT NULL,
        tool TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        result_json TEXT,
        status TEXT NOT NULL,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS discuss_batches (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        bot_id TEXT NOT NULL,
        run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'open',
        opened_at TEXT NOT NULL,
        due_at TEXT NOT NULL,
        hard_deadline_at TEXT NOT NULL,
        processed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS discuss_batch_messages (
        batch_id TEXT NOT NULL REFERENCES discuss_batches(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        PRIMARY KEY(batch_id, message_id)
      );

      CREATE TABLE IF NOT EXISTS discuss_decisions (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES discuss_batches(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        reason TEXT NOT NULL,
        confidence REAL NOT NULL,
        model TEXT,
        message_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        transport TEXT NOT NULL,
        command TEXT,
        args_json TEXT NOT NULL DEFAULT '[]',
        url TEXT,
        env_refs_json TEXT NOT NULL DEFAULT '{}',
        headers_json TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'disconnected',
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mcp_tool_policies (
        server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL,
        policy TEXT NOT NULL DEFAULT 'ask',
        PRIMARY KEY(server_id, tool_name)
      );

      CREATE TABLE IF NOT EXISTS plugins (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        description TEXT NOT NULL,
        author TEXT,
        entry_path TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'local',
        enabled INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'disabled',
        manifest_json TEXT NOT NULL DEFAULT '{}',
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS plugin_tool_policies (
        plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL,
        policy TEXT NOT NULL DEFAULT 'ask',
        PRIMARY KEY(plugin_id, tool_name)
      );

      CREATE TABLE IF NOT EXISTS code_executions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        code TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS code_execution_calls (
        execution_id TEXT NOT NULL REFERENCES code_executions(id) ON DELETE CASCADE,
        call_index INTEGER NOT NULL,
        tool_path TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        result_json TEXT,
        status TEXT NOT NULL,
        PRIMARY KEY(execution_id, call_index)
      );

      CREATE TABLE IF NOT EXISTS subagent_tasks (
        id TEXT PRIMARY KEY,
        parent_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        child_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        bot_id TEXT NOT NULL DEFAULT 'coder',
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        result_json TEXT,
        error TEXT,
        deadline_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_messages (
        id TEXT PRIMARY KEY,
        source_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        root_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        source_bot_id TEXT NOT NULL,
        target_bot_id TEXT NOT NULL,
        target_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        prompt TEXT NOT NULL,
        hop_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        started_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        expression TEXT NOT NULL,
        timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
        conversation_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        next_run_at TEXT,
        last_run_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS channel_sessions (
        channel_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        last_seq INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(channel_id, account_id)
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
      CREATE INDEX IF NOT EXISTS idx_messages_conversation
        ON messages(conversation_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_scope
        ON memories(scope, bot_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_run
        ON tool_calls(run_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_discuss_batches_due
        ON discuss_batches(status, due_at);
      CREATE INDEX IF NOT EXISTS idx_discuss_decisions_batch
        ON discuss_decisions(batch_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_discuss_batches_open
        ON discuss_batches(conversation_id, bot_id) WHERE status = 'open';
      CREATE INDEX IF NOT EXISTS idx_schedules_due
        ON schedules(enabled, next_run_at);
      CREATE INDEX IF NOT EXISTS idx_subagent_tasks_parent
        ON subagent_tasks(parent_run_id, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_agent_messages_source
        ON agent_messages(source_run_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_plugins_status
        ON plugins(status, enabled, updated_at DESC);
    `);
    this.ensureColumn("runs", "requested_by", "TEXT");
    this.ensureColumn("runs", "bot_id", "TEXT NOT NULL DEFAULT 'coder'");
    this.ensureColumn("runs", "bot_name", "TEXT NOT NULL DEFAULT 'Coder'");
    this.ensureColumn("runs", "bot_instructions", "TEXT");
    this.ensureColumn("runs", "model", "TEXT");
    this.ensureColumn("runs", "workspace_mode", "TEXT NOT NULL DEFAULT 'git-worktree'");
    this.ensureColumn("runs", "trigger_kind", "TEXT NOT NULL DEFAULT 'message'");
    this.ensureColumn("runs", "parent_run_id", "TEXT");
    this.ensureColumn("runs", "dispatch_key", "TEXT");
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_dispatch_key
        ON runs(dispatch_key);
    `);
    this.ensureColumn("runs", "tool_revision", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("runs", "tool_snapshot_hash", "TEXT");
    this.ensureColumn("runs", "tool_snapshot_json", "TEXT");
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_runs_tool_snapshot
        ON runs(tool_snapshot_hash);
    `);
    this.ensureColumn("runs", "reply_target_json", "TEXT");
    this.ensureColumn("conversations", "active_bot_id", "TEXT NOT NULL DEFAULT 'coder'");
    this.ensureColumn("inbox_items", "bot_id", "TEXT NOT NULL DEFAULT 'coder'");
    this.ensureColumn("bot_profiles", "workspace_mode", "TEXT NOT NULL DEFAULT 'git-worktree'");
    this.ensureColumn("discuss_batches", "run_id", "TEXT");
    this.ensureColumn("discuss_decisions", "run_id", "TEXT");
    this.ensureColumn("owner_identities", "aliases_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("owner_identities", "reply_address_json", "TEXT");
    this.ensureColumn("outbox_events", "attempts", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("outbox_events", "next_attempt_at", "TEXT");
    this.ensureColumn("outbox_events", "last_error", "TEXT");
    this.ensureColumn("code_executions", "error", "TEXT");
    this.ensureColumn("code_executions", "finished_at", "TEXT");
    this.ensureColumn("subagent_tasks", "child_run_id", "TEXT");
    this.ensureColumn("subagent_tasks", "bot_id", "TEXT NOT NULL DEFAULT 'coder'");
    this.ensureColumn("subagent_tasks", "result_json", "TEXT");
    this.ensureColumn("subagent_tasks", "deadline_at", "TEXT");
    this.ensureColumn("subagent_tasks", "started_at", "TEXT");
    this.ensureColumn("subagent_tasks", "finished_at", "TEXT");
    this.ensureColumn("agent_messages", "root_run_id", "TEXT");
    this.ensureColumn("agent_messages", "dedupe_key", "TEXT");
    this.ensureColumn("agent_messages", "result_json", "TEXT");
    this.ensureColumn("agent_messages", "error", "TEXT");
    this.ensureColumn("agent_messages", "started_at", "TEXT");
    this.ensureColumn("agent_messages", "finished_at", "TEXT");
    this.db.exec(`
      UPDATE subagent_tasks
      SET deadline_at = COALESCE(deadline_at, datetime(created_at, '+10 minutes'))
      WHERE deadline_at IS NULL;

      UPDATE agent_messages
      SET root_run_id = COALESCE(root_run_id, source_run_id),
          dedupe_key = COALESCE(dedupe_key, source_run_id || ':' || target_bot_id || ':' || prompt)
      WHERE root_run_id IS NULL OR dedupe_key IS NULL;
    `);
    const hasLegacySubagentResult = (
      this.db.query("PRAGMA table_info(subagent_tasks)").all() as Row[]
    ).some((row) => asString(row.name) === "result");
    if (hasLegacySubagentResult) {
      this.db.exec(`
        UPDATE subagent_tasks
        SET result_json = COALESCE(result_json, result)
        WHERE result_json IS NULL AND result IS NOT NULL;
      `);
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_agent_messages_root
        ON agent_messages(root_run_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_agent_messages_dedupe
        ON agent_messages(dedupe_key);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_inbox_conversation_bot
        ON inbox_items(conversation_id, bot_id, status, received_at);
    `);
    this.ensureColumn("approval_requests", "can_accept_for_session", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("inbox_items", "error", "TEXT");
    this.ensureMemoryUniqueIndexes();
    this.seedDefaultBot();
  }

  private ensureColumn(
    table:
      | "runs"
      | "approval_requests"
      | "inbox_items"
      | "conversations"
      | "bot_profiles"
      | "owner_identities"
      | "discuss_batches"
      | "discuss_decisions"
      | "outbox_events"
      | "code_executions"
      | "subagent_tasks"
      | "agent_messages",
    column: string,
    definition: string,
  ): void {
    const rows = this.db.query(`PRAGMA table_info(${table})`).all() as Row[];
    if (rows.some((row) => asString(row.name) === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private ensureMemoryUniqueIndexes(): void {
    this.db.exec(`
      DELETE FROM memories
      WHERE bot_id IS NULL
        AND id NOT IN (
          SELECT id FROM memories AS candidate
          WHERE candidate.bot_id IS NULL
            AND candidate.scope = memories.scope
            AND candidate.kind = memories.kind
            AND candidate.normalized_content = memories.normalized_content
          ORDER BY candidate.updated_at DESC, candidate.id DESC
          LIMIT 1
        );

      DELETE FROM memories
      WHERE bot_id IS NOT NULL
        AND id NOT IN (
          SELECT id FROM memories AS candidate
          WHERE candidate.bot_id IS NOT NULL
            AND candidate.bot_id = memories.bot_id
            AND candidate.scope = memories.scope
            AND candidate.kind = memories.kind
            AND candidate.normalized_content = memories.normalized_content
          ORDER BY candidate.updated_at DESC, candidate.id DESC
          LIMIT 1
        );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_owner_unique
        ON memories(scope, kind, normalized_content) WHERE bot_id IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_bot_unique
        ON memories(scope, bot_id, kind, normalized_content) WHERE bot_id IS NOT NULL;
    `);
  }

  private migrateLegacyReplyAddresses(): void {
    const runRows = this.db
      .query(
        `SELECT runs.id, runs.reply_target_json, conversations.channel, conversations.account_id
         FROM runs
         LEFT JOIN conversations ON conversations.id = runs.conversation_id
         WHERE runs.reply_target_json IS NOT NULL`,
      )
      .all() as Row[];
    for (const row of runRows) {
      const converted = legacyReplyAddress(
        parseJson<unknown>(row.reply_target_json, null),
        asString(row.channel, "unknown"),
        asString(row.account_id, "unknown"),
      );
      if (!converted) continue;
      this.db
        .query("UPDATE runs SET reply_target_json = ? WHERE id = ?")
        .run(JSON.stringify(converted), asString(row.id));
    }

    const messageRows = this.db
      .query(
        `SELECT id, reply_address_json, channel_id, account_id
         FROM messages
         WHERE reply_address_json IS NOT NULL`,
      )
      .all() as Row[];
    for (const row of messageRows) {
      const converted = legacyReplyAddress(
        parseJson<unknown>(row.reply_address_json, null),
        asString(row.channel_id, "unknown"),
        asString(row.account_id, "unknown"),
      );
      if (!converted) continue;
      this.db
        .query("UPDATE messages SET reply_address_json = ? WHERE id = ?")
        .run(JSON.stringify(converted), asString(row.id));
    }
  }

  private migrateLegacyMessages(): void {
    const inboxRows = this.db
      .query(
        `SELECT inbox_items.*, conversations.channel, conversations.account_id,
                conversations.external_id AS conversation_external_id
         FROM inbox_items
         JOIN conversations ON conversations.id = inbox_items.conversation_id`,
      )
      .all() as Row[];
    const insertMessage = this.db.query(
      `INSERT INTO messages
        (id, conversation_id, channel_id, account_id, external_conversation_id,
         external_message_id, role, sender_id, sender_name, text, raw_json,
         reply_address_json, reply_to_external_message_id, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, ?, ?)
       ON CONFLICT DO NOTHING`,
    );
    for (const row of inboxRows) {
      insertMessage.run(
        `legacy-inbox:${asString(row.id)}`,
        asString(row.conversation_id),
        asString(row.channel, "unknown"),
        asString(row.account_id, "unknown"),
        asNullableString(row.conversation_external_id),
        asNullableString(row.external_message_id),
        "user",
        asNullableString(row.sender_id),
        asString(row.text),
        JSON.stringify(parseJson<unknown>(row.raw_json, null)),
        JSON.stringify({
          kind: "legacy_inbox",
          inboxId: asString(row.id),
          status: asString(row.status),
          error: asNullableString(row.error),
        }),
        asString(row.created_at, nowIso()),
      );
    }

    const runRows = this.db
      .query(
        `SELECT runs.*, conversations.channel, conversations.account_id,
                conversations.external_id AS conversation_external_id
         FROM runs
         JOIN conversations ON conversations.id = runs.conversation_id`,
      )
      .all() as Row[];
    const linkRunMessage = this.db.query(
      `INSERT INTO run_messages (run_id, message_id) VALUES (?, ?)
       ON CONFLICT DO NOTHING`,
    );
    for (const row of runRows) {
      const runId = asString(row.id);
      const userMessageId = `legacy-run-user:${runId}`;
      insertMessage.run(
        userMessageId,
        asString(row.conversation_id),
        asString(row.channel, "unknown"),
        asString(row.account_id, "unknown"),
        asNullableString(row.conversation_external_id),
        null,
        "user",
        asNullableString(row.requested_by),
        asString(row.prompt),
        JSON.stringify({ kind: "legacy_run_prompt", runId }),
        JSON.stringify({
          kind: "legacy_run_prompt",
          trigger: asString(row.trigger_kind, "message"),
        }),
        asString(row.created_at, nowIso()),
      );
      linkRunMessage.run(runId, userMessageId);

      const output = asString(row.output);
      if (!output) continue;
      const assistantMessageId = `legacy-run-assistant:${runId}`;
      insertMessage.run(
        assistantMessageId,
        asString(row.conversation_id),
        asString(row.channel, "unknown"),
        asString(row.account_id, "unknown"),
        asNullableString(row.conversation_external_id),
        null,
        "assistant",
        null,
        output,
        JSON.stringify({ kind: "legacy_run_output", runId }),
        JSON.stringify({ kind: "legacy_run_output", runId }),
        asString(row.finished_at, asString(row.updated_at, nowIso())),
      );
      linkRunMessage.run(runId, assistantMessageId);
    }
  }

  private seedDefaultBot(): void {
    const now = nowIso();
    this.db
      .query(
        `INSERT INTO bot_profiles
          (id, name, description, instructions, agent, model, workspace_path, workspace_mode, enabled, created_at, updated_at)
         VALUES ('coder', 'Coder', 'General-purpose coding and repository assistant.',
           'Act as the coding agent for this conversation. Work directly in the provided repository, inspect before changing, make focused changes, and report concrete results.', 'codex', NULL, NULL, 'git-worktree', 1, ?, ?)
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
    workspaceMode?: WorkspaceMode;
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
          (id, name, description, instructions, agent, model, workspace_path, workspace_mode, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           instructions = excluded.instructions,
           agent = excluded.agent,
           model = excluded.model,
           workspace_path = excluded.workspace_path,
           workspace_mode = excluded.workspace_mode,
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
        input.workspaceMode ?? "git-worktree",
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

  listConversations(limit = 100): ConversationRecord[] {
    const rows = this.db
      .query(
        `SELECT * FROM conversations
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(Math.max(1, Math.min(limit, 500))) as Row[];
    return rows.map(mapConversation);
  }

  getLatestConversationSession(
    conversationId: string,
    botId: string,
  ): { nativeThreadId: string | null } | null {
    const row = this.db
      .query(
        `SELECT native_thread_id FROM runs
         WHERE conversation_id = ? AND bot_id = ? AND native_thread_id IS NOT NULL
           AND parent_run_id IS NULL
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
    replyAddress?: OutboundAddress | null;
    trigger?: string;
    parentRunId?: string | null;
    dispatchKey?: string | null;
    workspaceMode?: WorkspaceMode;
    toolRevision?: number;
    toolSnapshotHash?: string | null;
    toolSnapshotJson?: string | null;
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
      workspaceMode: input.workspaceMode ?? "git-worktree",
      trigger: input.trigger ?? "message",
      parentRunId: input.parentRunId ?? null,
      dispatchKey: input.dispatchKey ?? null,
      toolRevision: input.toolRevision ?? 0,
      toolSnapshotHash: input.toolSnapshotHash ?? null,
      toolSnapshotJson: input.toolSnapshotJson ?? null,
      output: "",
      error: null,
      replyAddress: input.replyAddress ?? null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
    };
    this.db
      .query(
        `INSERT INTO runs
          (id, conversation_id, prompt, requested_by, bot_id, bot_name, bot_instructions, state, agent, model, native_thread_id, native_turn_id,
           workspace_path, workspace_mode, trigger_kind, parent_run_id, dispatch_key, tool_revision, tool_snapshot_hash, tool_snapshot_json,
           output, error, reply_target_json, created_at, updated_at, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, '', NULL, ?, ?, ?, NULL, NULL)
         ON CONFLICT(dispatch_key) DO NOTHING`,
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
        record.workspaceMode,
        record.trigger,
        record.parentRunId,
        record.dispatchKey,
        record.toolRevision,
        record.toolSnapshotHash,
        record.toolSnapshotJson,
        record.replyAddress ? JSON.stringify(record.replyAddress) : null,
        record.createdAt,
        record.updatedAt,
      );
    if (record.dispatchKey) {
      const existing = this.getRunByDispatchKey(record.dispatchKey);
      if (existing) return existing;
    }
    return record;
  }

  getRun(id: string): RunRecord | null {
    const row = this.db.query("SELECT * FROM runs WHERE id = ?").get(id) as Row | null;
    return row ? mapRun(row) : null;
  }

  getRunByDispatchKey(dispatchKey: string): RunRecord | null {
    const row = this.db
      .query("SELECT * FROM runs WHERE dispatch_key = ? LIMIT 1")
      .get(dispatchKey) as Row | null;
    return row ? mapRun(row) : null;
  }

  findToolSnapshotJson(hash: string): string | null {
    const row = this.db
      .query(
        `SELECT tool_snapshot_json FROM runs
         WHERE tool_snapshot_hash = ? AND tool_snapshot_json IS NOT NULL
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(hash) as Row | null;
    return asNullableString(row?.tool_snapshot_json);
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
      prompt?: string;
      state?: RunState;
      nativeThreadId?: string | null;
      nativeTurnId?: string | null;
      workspacePath?: string | null;
      toolRevision?: number;
      toolSnapshotHash?: string | null;
      toolSnapshotJson?: string | null;
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
          prompt = ?, state = ?, native_thread_id = ?, native_turn_id = ?, workspace_path = ?,
          tool_revision = ?, tool_snapshot_hash = ?,
          tool_snapshot_json = ?,
          output = ?, error = ?, updated_at = ?, started_at = ?, finished_at = ?
         WHERE id = ?`,
      )
      .run(
        input.prompt === undefined ? current.prompt : input.prompt,
        input.state ?? current.state,
        input.nativeThreadId === undefined ? current.nativeThreadId : input.nativeThreadId,
        input.nativeTurnId === undefined ? current.nativeTurnId : input.nativeTurnId,
        input.workspacePath === undefined ? current.workspacePath : input.workspacePath,
        input.toolRevision === undefined ? current.toolRevision : input.toolRevision,
        input.toolSnapshotHash === undefined ? current.toolSnapshotHash : input.toolSnapshotHash,
        input.toolSnapshotJson === undefined ? current.toolSnapshotJson : input.toolSnapshotJson,
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

  insertMessage(input: {
    conversationId: string | null;
    channelId: string;
    accountId: string;
    externalConversationId?: string | null;
    externalMessageId?: string | null;
    role: MessageRecord["role"];
    senderId?: string | null;
    senderName?: string | null;
    text: string;
    raw?: unknown;
    replyAddress?: OutboundAddress | null;
    replyToExternalMessageId?: string | null;
    metadata?: Record<string, unknown>;
    createdAt?: string;
  }): { message: MessageRecord; duplicate: boolean } {
    const createdAt = input.createdAt ?? nowIso();
    if (input.externalMessageId) {
      const existing = this.db
        .query(
          `SELECT * FROM messages
           WHERE channel_id = ? AND account_id = ? AND external_message_id = ?`,
        )
        .get(input.channelId, input.accountId, input.externalMessageId) as Row | null;
      if (existing) return { message: mapMessage(existing), duplicate: true };
    }

    const message: MessageRecord = {
      id: createId("msg"),
      conversationId: input.conversationId,
      channelId: input.channelId,
      accountId: input.accountId,
      externalConversationId: input.externalConversationId ?? null,
      externalMessageId: input.externalMessageId ?? null,
      role: input.role,
      senderId: input.senderId ?? null,
      senderName: input.senderName ?? null,
      text: input.text,
      raw: input.raw ?? null,
      replyAddress: input.replyAddress ?? null,
      replyToExternalMessageId: input.replyToExternalMessageId ?? null,
      metadata: input.metadata ?? {},
      createdAt,
    };
    this.db
      .query(
        `INSERT INTO messages
          (id, conversation_id, channel_id, account_id, external_conversation_id,
           external_message_id, role, sender_id, sender_name, text, raw_json,
           reply_address_json, reply_to_external_message_id, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.conversationId,
        message.channelId,
        message.accountId,
        message.externalConversationId,
        message.externalMessageId,
        message.role,
        message.senderId,
        message.senderName,
        message.text,
        JSON.stringify(message.raw),
        message.replyAddress ? JSON.stringify(message.replyAddress) : null,
        message.replyToExternalMessageId,
        JSON.stringify(message.metadata),
        message.createdAt,
      );
    return { message, duplicate: false };
  }

  getMessage(id: string): MessageRecord | null {
    const row = this.db.query("SELECT * FROM messages WHERE id = ?").get(id) as Row | null;
    return row ? mapMessage(row) : null;
  }

  listMessages(conversationId: string, limit = 50): MessageRecord[] {
    const rows = this.db
      .query(
        `SELECT * FROM messages
         WHERE conversation_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(conversationId, Math.max(1, Math.min(limit, 500))) as Row[];
    return rows.map(mapMessage).reverse();
  }

  linkRunMessages(runId: string, messageIds: string[]): void {
    if (messageIds.length === 0) return;
    const statement = this.db.query(
      `INSERT INTO run_messages (run_id, message_id)
       VALUES (?, ?)
       ON CONFLICT DO NOTHING`,
    );
    this.db.transaction(() => {
      for (const messageId of messageIds) statement.run(runId, messageId);
    })();
  }

  listRunMessages(runId: string): MessageRecord[] {
    const rows = this.db
      .query(
        `SELECT messages.*
         FROM messages
         JOIN run_messages ON run_messages.message_id = messages.id
         WHERE run_messages.run_id = ?
         ORDER BY messages.created_at ASC, messages.id ASC`,
      )
      .all(runId) as Row[];
    return rows.map(mapMessage);
  }

  getConversationPolicy(conversationId: string): ConversationPolicyRecord {
    const row = this.db
      .query("SELECT * FROM conversation_policies WHERE conversation_id = ?")
      .get(conversationId) as Row | null;
    if (row) return mapPolicy(row);
    return {
      conversationId,
      observeAll: false,
      discussEnabled: true,
      updatedAt: nowIso(),
    };
  }

  setConversationPolicy(input: {
    conversationId: string;
    observeAll?: boolean;
    discussEnabled?: boolean;
  }): ConversationPolicyRecord {
    const current = this.getConversationPolicy(input.conversationId);
    const updatedAt = nowIso();
    this.db
      .query(
        `INSERT INTO conversation_policies
          (conversation_id, observe_all, discuss_enabled, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET
           observe_all = excluded.observe_all,
           discuss_enabled = excluded.discuss_enabled,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.conversationId,
        (input.observeAll ?? current.observeAll) ? 1 : 0,
        (input.discussEnabled ?? current.discussEnabled) ? 1 : 0,
        updatedAt,
      );
    return this.getConversationPolicy(input.conversationId);
  }

  getOwner(): OwnerRecord | null {
    const row = this.db
      .query("SELECT * FROM owners ORDER BY created_at ASC LIMIT 1")
      .get() as Row | null;
    return row ? mapOwner(row) : null;
  }

  ensureOwner(name = "Owner"): OwnerRecord {
    const existing = this.getOwner();
    if (existing) return existing;
    const now = nowIso();
    const owner: OwnerRecord = {
      id: createId("owner"),
      name,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .query(
        `INSERT INTO owners (id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(owner.id, owner.name, owner.createdAt, owner.updatedAt);
    return owner;
  }

  getOwnerIdentity(input: {
    channelId: string;
    accountId: string;
    senderId: string;
    conversationKind: ConversationKind;
  }): OwnerIdentityRecord | null {
    const row = this.db
      .query(
        `SELECT * FROM owner_identities
         WHERE channel_id = ? AND account_id = ? AND sender_id = ? AND conversation_kind = ?`,
      )
      .get(input.channelId, input.accountId, input.senderId, input.conversationKind) as Row | null;
    return row ? mapOwnerIdentity(row) : null;
  }

  bindOwnerIdentity(input: {
    ownerId: string;
    channelId: string;
    accountId: string;
    senderId: string;
    conversationKind: ConversationKind;
    displayName?: string | null;
    aliases?: string[];
    replyAddress?: OutboundAddress | null;
  }): OwnerIdentityRecord {
    const now = nowIso();
    this.db
      .query(
        `INSERT INTO owner_identities
          (id, owner_id, channel_id, account_id, sender_id, conversation_kind, display_name,
           aliases_json, reply_address_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_id, account_id, sender_id, conversation_kind) DO UPDATE SET
           owner_id = excluded.owner_id,
           display_name = excluded.display_name,
           aliases_json = excluded.aliases_json,
           reply_address_json = excluded.reply_address_json`,
      )
      .run(
        createId("identity"),
        input.ownerId,
        input.channelId,
        input.accountId,
        input.senderId,
        input.conversationKind,
        input.displayName ?? null,
        JSON.stringify(normalizeAliases(input.aliases ?? [])),
        input.replyAddress ? JSON.stringify(input.replyAddress) : null,
        now,
      );
    const identity = this.getOwnerIdentity(input);
    if (!identity) throw new Error("Owner identity write failed");
    return identity;
  }

  listOwnerIdentities(ownerId?: string): OwnerIdentityRecord[] {
    const rows = this.db
      .query(
        `SELECT * FROM owner_identities
         ${ownerId ? "WHERE owner_id = ?" : ""}
         ORDER BY created_at ASC`,
      )
      .all(...(ownerId ? [ownerId] : [])) as Row[];
    return rows.map(mapOwnerIdentity);
  }

  /**
   * Resolves an owner from a platform sender. Group and thread identities may
   * use a different OpenID than the private chat that completed pairing, so
   * aliases are checked before falling back to the private identity.
   */
  resolveOwnerIdentity(input: {
    channelId: string;
    accountId: string;
    senderId: string;
    conversationKind: ConversationKind;
    aliases?: string[];
  }): OwnerIdentityRecord | null {
    const ids = new Set(
      [input.senderId, ...(input.aliases ?? [])].map((value) => value.trim()).filter(Boolean),
    );
    const candidates = this.listOwnerIdentities().filter(
      (identity) =>
        identity.channelId === input.channelId &&
        identity.accountId === input.accountId &&
        (identity.conversationKind === input.conversationKind ||
          identity.conversationKind === "private"),
    );
    const matches = (identity: OwnerIdentityRecord) =>
      ids.has(identity.senderId) || identity.aliases.some((alias) => ids.has(alias));
    return (
      candidates.find(
        (identity) => identity.conversationKind === input.conversationKind && matches(identity),
      ) ??
      candidates.find((identity) => identity.conversationKind === "private" && matches(identity)) ??
      null
    );
  }

  createOwnerPairingCode(input: { codeHash: string; ownerId: string; expiresAt: string }): void {
    const now = nowIso();
    this.db
      .query(
        `INSERT INTO owner_pairing_codes (code_hash, owner_id, expires_at, used_at, created_at)
         VALUES (?, ?, ?, NULL, ?)`,
      )
      .run(input.codeHash, input.ownerId, input.expiresAt, now);
  }

  redeemOwnerPairingCode(input: {
    codeHash: string;
    channelId: string;
    accountId: string;
    senderId: string;
    conversationKind: ConversationKind;
    displayName?: string | null;
    aliases?: string[];
    replyAddress?: OutboundAddress | null;
  }): OwnerIdentityRecord | null {
    return this.db.transaction(() => {
      const now = nowIso();
      const row = this.db
        .query(
          `SELECT owner_id FROM owner_pairing_codes
           WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`,
        )
        .get(input.codeHash, now) as Row | null;
      if (!row) return null;
      const ownerId = asString(row.owner_id);
      this.db
        .query("UPDATE owner_pairing_codes SET used_at = ? WHERE code_hash = ?")
        .run(now, input.codeHash);
      return this.bindOwnerIdentity({
        ownerId,
        channelId: input.channelId,
        accountId: input.accountId,
        senderId: input.senderId,
        conversationKind: input.conversationKind,
        displayName: input.displayName ?? null,
        aliases: input.aliases ?? [],
        replyAddress: input.replyAddress ?? null,
      });
    })();
  }

  listMemories(
    input: {
      scope?: MemoryRecord["scope"];
      botId?: string | null;
      kind?: string;
      tag?: string;
      query?: string;
      includeDeleted?: boolean;
      limit?: number;
    } = {},
  ): MemoryRecord[] {
    const clauses = [input.includeDeleted ? "1 = 1" : "status = 'active'"];
    const params: Array<string | number | null> = [];
    if (input.scope) {
      clauses.push("scope = ?");
      params.push(input.scope);
    }
    if (input.botId !== undefined) {
      clauses.push("bot_id IS ?");
      params.push(input.botId ?? null);
    }
    if (input.kind) {
      clauses.push("kind = ?");
      params.push(input.kind);
    }
    if (input.tag) {
      clauses.push("EXISTS (SELECT 1 FROM json_each(memories.tags_json) WHERE value = ?)");
      params.push(input.tag);
    }
    if (input.query) {
      const ftsQuery = toFtsQuery(input.query);
      if (ftsQuery) {
        clauses.push("id IN (SELECT memory_id FROM memories_fts WHERE memories_fts MATCH ?)");
        params.push(ftsQuery);
      } else {
        clauses.push("(content LIKE ? OR tags_json LIKE ?)");
        params.push(`%${input.query}%`, `%${input.query}%`);
      }
    }
    const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
    const rows = this.db
      .query(
        `SELECT * FROM memories
         WHERE ${clauses.join(" AND ")}
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(...params, limit) as Row[];
    return rows.map(mapMemory);
  }

  getMemory(id: string): MemoryRecord | null {
    const row = this.db.query("SELECT * FROM memories WHERE id = ?").get(id) as Row | null;
    return row ? mapMemory(row) : null;
  }

  updateMemory(input: {
    id: string;
    scope: MemoryRecord["scope"];
    botId: string | null;
    kind: string;
    content: string;
    normalizedContent: string;
    tags: string[];
    confidence: number;
  }): MemoryRecord {
    return this.db.transaction(() => {
      const existing = this.getMemory(input.id);
      if (!existing) throw new Error(`Memory not found: ${input.id}`);
      this.db
        .query(
          `UPDATE memories SET
             scope = ?, bot_id = ?, kind = ?, content = ?, normalized_content = ?,
             tags_json = ?, confidence = ?, updated_at = ?, accessed_at = ?
           WHERE id = ?`,
        )
        .run(
          input.scope,
          input.scope === "owner" ? null : input.botId,
          input.kind,
          input.content,
          input.normalizedContent,
          JSON.stringify(input.tags),
          input.confidence,
          nowIso(),
          nowIso(),
          input.id,
        );
      this.syncMemoryFts(input.id);
      const updated = this.getMemory(input.id);
      if (!updated) throw new Error(`Memory not found after update: ${input.id}`);
      return updated;
    })();
  }

  upsertMemory(input: {
    scope: MemoryRecord["scope"];
    botId: string | null;
    kind: string;
    content: string;
    normalizedContent: string;
    tags: string[];
    confidence: number;
    sourceRunId?: string | null;
    sourceMessageId?: string | null;
  }): MemoryRecord {
    const existing = this.db
      .query(
        `SELECT * FROM memories
         WHERE scope = ? AND bot_id IS ? AND kind = ? AND normalized_content = ?`,
      )
      .get(input.scope, input.botId, input.kind, input.normalizedContent) as Row | null;
    const now = nowIso();
    if (existing) {
      this.db
        .query(
          `UPDATE memories SET
             tags_json = ?, confidence = ?, status = 'active', updated_at = ?, accessed_at = ?,
             source_run_id = COALESCE(?, source_run_id),
             source_message_id = COALESCE(?, source_message_id)
           WHERE id = ?`,
        )
        .run(
          JSON.stringify(input.tags),
          input.confidence,
          now,
          now,
          input.sourceRunId ?? null,
          input.sourceMessageId ?? null,
          asString(existing.id),
        );
      this.syncMemoryFts(asString(existing.id));
      return this.getMemory(asString(existing.id)) as MemoryRecord;
    }

    const memory: MemoryRecord = {
      id: createId("memory"),
      scope: input.scope,
      botId: input.botId,
      kind: input.kind,
      content: input.content,
      tags: input.tags,
      confidence: input.confidence,
      status: "active",
      sourceRunId: input.sourceRunId ?? null,
      sourceMessageId: input.sourceMessageId ?? null,
      createdAt: now,
      updatedAt: now,
      accessedAt: now,
    };
    this.db
      .query(
        `INSERT INTO memories
          (id, scope, bot_id, kind, content, normalized_content, tags_json, confidence,
           status, source_run_id, source_message_id, created_at, updated_at, accessed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
      )
      .run(
        memory.id,
        memory.scope,
        memory.botId,
        memory.kind,
        memory.content,
        input.normalizedContent,
        JSON.stringify(memory.tags),
        memory.confidence,
        memory.sourceRunId,
        memory.sourceMessageId,
        memory.createdAt,
        memory.updatedAt,
        memory.accessedAt,
      );
    this.syncMemoryFts(memory.id);
    return memory;
  }

  private syncMemoryFts(memoryId: string): void {
    const memory = this.getMemory(memoryId);
    if (!memory) return;
    this.db.query("DELETE FROM memories_fts WHERE memory_id = ?").run(memoryId);
    this.db
      .query(
        `INSERT INTO memories_fts (memory_id, content, tags, cjk_tokens)
         VALUES (?, ?, ?, ?)`,
      )
      .run(memory.id, memory.content, memory.tags.join(" "), cjkBigrams(memory.content));
  }

  setMemoryStatus(id: string, status: MemoryRecord["status"]): MemoryRecord {
    this.db
      .query("UPDATE memories SET status = ?, updated_at = ?, accessed_at = ? WHERE id = ?")
      .run(status, nowIso(), nowIso(), id);
    const memory = this.getMemory(id);
    if (!memory) throw new Error(`Memory not found: ${id}`);
    return memory;
  }

  deleteMemoryPermanently(id: string): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM memories_fts WHERE memory_id = ?").run(id);
      this.db.query("DELETE FROM memories WHERE id = ?").run(id);
    })();
  }

  getScratchpad(conversationId: string, botId: string): ScratchpadRecord | null {
    const row = this.db
      .query(
        `SELECT * FROM scratchpads
         WHERE conversation_id = ? AND bot_id = ? AND expires_at > ?`,
      )
      .get(conversationId, botId, nowIso()) as Row | null;
    if (row) return mapScratchpad(row);
    this.db
      .query("DELETE FROM scratchpads WHERE conversation_id = ? AND bot_id = ? AND expires_at <= ?")
      .run(conversationId, botId, nowIso());
    return null;
  }

  listScratchpads(conversationId?: string): ScratchpadRecord[] {
    const now = nowIso();
    this.db.query("DELETE FROM scratchpads WHERE expires_at <= ?").run(now);
    const rows = conversationId
      ? (this.db
          .query(
            `SELECT * FROM scratchpads
             WHERE conversation_id = ?
             ORDER BY updated_at DESC`,
          )
          .all(conversationId) as Row[])
      : (this.db
          .query("SELECT * FROM scratchpads ORDER BY updated_at DESC LIMIT 200")
          .all() as Row[]);
    return rows.map(mapScratchpad);
  }

  purgeExpiredScratchpads(): number {
    return this.db.query("DELETE FROM scratchpads WHERE expires_at <= ?").run(nowIso()).changes;
  }

  deleteScratchpad(conversationId: string, botId: string): boolean {
    return (
      this.db
        .query("DELETE FROM scratchpads WHERE conversation_id = ? AND bot_id = ?")
        .run(conversationId, botId).changes > 0
    );
  }

  setScratchpad(input: {
    conversationId: string;
    botId: string;
    content: unknown;
    expectedRevision?: number;
    expiresAt: string;
  }): ScratchpadRecord {
    const current = this.getScratchpad(input.conversationId, input.botId);
    if (
      input.expectedRevision !== undefined &&
      current &&
      current.revision !== input.expectedRevision
    ) {
      throw new Error(
        `Scratchpad revision conflict: expected ${input.expectedRevision}, actual ${current.revision}`,
      );
    }
    if (input.expectedRevision !== undefined && !current && input.expectedRevision !== 0) {
      throw new Error("Scratchpad revision conflict: scratchpad does not exist");
    }
    const revision = (current?.revision ?? 0) + 1;
    const updatedAt = nowIso();
    this.db
      .query(
        `INSERT INTO scratchpads
          (conversation_id, bot_id, content_json, revision, expires_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id, bot_id) DO UPDATE SET
           content_json = excluded.content_json,
           revision = excluded.revision,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.conversationId,
        input.botId,
        JSON.stringify(input.content),
        revision,
        input.expiresAt,
        updatedAt,
      );
    return {
      conversationId: input.conversationId,
      botId: input.botId,
      content: input.content,
      revision,
      expiresAt: input.expiresAt,
      updatedAt,
    };
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

  ensureOutboxChunks(outboxId: string, chunks: string[]): OutboxChunkRecord[] {
    const existing = this.listOutboxChunks(outboxId);
    if (existing.length > 0) return existing;
    const createdAt = nowIso();
    const insert = this.db.query(
      `INSERT INTO outbox_chunks
        (id, outbox_id, chunk_index, text, status, attempts, created_at)
       VALUES (?, ?, ?, ?, 'pending', 0, ?)`,
    );
    this.db.transaction(() => {
      chunks.forEach((text, index) => {
        insert.run(createId("chunk"), outboxId, index, text, createdAt);
      });
    })();
    return this.listOutboxChunks(outboxId);
  }

  listOutboxChunks(outboxId: string): OutboxChunkRecord[] {
    const rows = this.db
      .query(
        `SELECT * FROM outbox_chunks
         WHERE outbox_id = ?
         ORDER BY chunk_index ASC`,
      )
      .all(outboxId) as Row[];
    return rows.map((row) => ({
      id: asString(row.id),
      outboxId: asString(row.outbox_id),
      index: Number(row.chunk_index ?? 0),
      text: asString(row.text),
      status: asString(row.status, "pending") as OutboxChunkRecord["status"],
      attempts: Number(row.attempts ?? 0),
      externalMessageId: asNullableString(row.external_message_id),
      lastError: asNullableString(row.last_error),
    }));
  }

  markOutboxChunkDelivering(id: string): void {
    this.db.query("UPDATE outbox_chunks SET status = 'delivering' WHERE id = ?").run(id);
  }

  markOutboxChunkDelivered(id: string, externalMessageId?: string): void {
    this.db
      .query(
        `UPDATE outbox_chunks
         SET status = 'delivered', external_message_id = ?, delivered_at = ?
         WHERE id = ?`,
      )
      .run(externalMessageId ?? null, nowIso(), id);
  }

  failOutboxChunk(id: string, error: string, attempts: number): void {
    this.db
      .query(
        `UPDATE outbox_chunks
         SET status = 'pending', attempts = ?, last_error = ?
         WHERE id = ?`,
      )
      .run(attempts, error, id);
  }

  pendingOutbox(
    limit = 100,
    force = true,
  ): Array<{
    id: string;
    runId: string | null;
    type: string;
    payload: unknown;
    attempts: number;
    lastError: string | null;
    createdAt: string;
  }> {
    const rows = this.db
      .query(
        `SELECT * FROM outbox_events
         WHERE status = 'pending'
           ${force ? "" : "AND (next_attempt_at IS NULL OR next_attempt_at <= ?)"}
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(
        ...(force
          ? [Math.max(1, Math.min(limit, 1000))]
          : [nowIso(), Math.max(1, Math.min(limit, 1000))]),
      ) as Row[];
    return rows.map((row) => ({
      id: asString(row.id),
      runId: asNullableString(row.run_id),
      type: asString(row.type),
      payload: parseJson<unknown>(row.payload_json, null),
      attempts: Number(row.attempts ?? 0),
      lastError: asNullableString(row.last_error),
      createdAt: asString(row.created_at),
    }));
  }

  markOutboxDelivering(id: string): void {
    this.db.query("UPDATE outbox_events SET status = 'delivering' WHERE id = ?").run(id);
  }

  failOutbox(id: string, error: string, retryable: boolean): void {
    const row = this.db
      .query("SELECT attempts FROM outbox_events WHERE id = ?")
      .get(id) as Row | null;
    const attempts = Number(row?.attempts ?? 0) + 1;
    if (!retryable || attempts >= 8) {
      this.db
        .query(
          `UPDATE outbox_events
           SET status = 'dead', attempts = ?, last_error = ?, next_attempt_at = NULL
           WHERE id = ?`,
        )
        .run(attempts, error, id);
      return;
    }
    const delayMs = [5_000, 10_000, 30_000, 120_000, 600_000][Math.min(attempts - 1, 4)] ?? 600_000;
    this.db
      .query(
        `UPDATE outbox_events
         SET status = 'pending', attempts = ?, last_error = ?, next_attempt_at = ?
         WHERE id = ?`,
      )
      .run(attempts, error, new Date(Date.now() + delayMs).toISOString(), id);
  }

  markOutboxDelivered(id: string): void {
    this.db
      .query("UPDATE outbox_events SET status = 'delivered', delivered_at = ? WHERE id = ?")
      .run(nowIso(), id);
  }

  getOutbox(id: string): {
    id: string;
    status: "pending" | "delivering" | "delivered" | "dead";
    attempts: number;
    nextAttemptAt: string | null;
    lastError: string | null;
  } | null {
    const row = this.db
      .query(
        `SELECT id, status, attempts, next_attempt_at, last_error
         FROM outbox_events WHERE id = ?`,
      )
      .get(id) as Row | null;
    if (!row) return null;
    return {
      id: asString(row.id),
      status: asString(row.status, "pending") as "pending" | "delivering" | "delivered" | "dead",
      attempts: Number(row.attempts ?? 0),
      nextAttemptAt: asNullableString(row.next_attempt_at),
      lastError: asNullableString(row.last_error),
    };
  }

  recoverOutboxAfterRestart(): number {
    const result = this.db
      .query("UPDATE outbox_events SET status = 'pending' WHERE status = 'delivering'")
      .run();
    return result.changes;
  }

  createToolCall(input: {
    runId: string;
    namespace: string;
    tool: string;
    arguments: unknown;
  }): ToolCallRecord {
    const call: ToolCallRecord = {
      id: createId("toolcall"),
      runId: input.runId,
      namespace: input.namespace,
      tool: input.tool,
      arguments: input.arguments,
      result: null,
      status: "running",
      error: null,
      startedAt: nowIso(),
      finishedAt: null,
    };
    this.db
      .query(
        `INSERT INTO tool_calls
          (id, run_id, namespace, tool, arguments_json, result_json, status, error, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, NULL, 'running', NULL, ?, NULL)`,
      )
      .run(
        call.id,
        call.runId,
        call.namespace,
        call.tool,
        JSON.stringify(call.arguments),
        call.startedAt,
      );
    return call;
  }

  finishToolCall(input: {
    id: string;
    status: "succeeded" | "failed" | "denied";
    result?: unknown;
    error?: string | null;
  }): ToolCallRecord {
    this.db
      .query(
        `UPDATE tool_calls
         SET result_json = ?, status = ?, error = ?, finished_at = ?
         WHERE id = ?`,
      )
      .run(
        input.result === undefined ? null : JSON.stringify(input.result),
        input.status,
        input.error ?? null,
        nowIso(),
        input.id,
      );
    const row = this.db.query("SELECT * FROM tool_calls WHERE id = ?").get(input.id) as Row | null;
    if (!row) throw new Error(`Tool call not found: ${input.id}`);
    return {
      id: asString(row.id),
      runId: asString(row.run_id),
      namespace: asString(row.namespace),
      tool: asString(row.tool),
      arguments: parseJson<unknown>(row.arguments_json, null),
      result: parseJson<unknown>(row.result_json, null),
      status: asString(row.status) as ToolCallRecord["status"],
      error: asNullableString(row.error),
      startedAt: asString(row.started_at),
      finishedAt: asNullableString(row.finished_at),
    };
  }

  listToolCalls(runId: string): ToolCallRecord[] {
    const rows = this.db
      .query("SELECT * FROM tool_calls WHERE run_id = ? ORDER BY started_at ASC")
      .all(runId) as Row[];
    return rows.map((row) => ({
      id: asString(row.id),
      runId: asString(row.run_id),
      namespace: asString(row.namespace),
      tool: asString(row.tool),
      arguments: parseJson<unknown>(row.arguments_json, null),
      result: parseJson<unknown>(row.result_json, null),
      status: asString(row.status) as ToolCallRecord["status"],
      error: asNullableString(row.error),
      startedAt: asString(row.started_at),
      finishedAt: asNullableString(row.finished_at),
    }));
  }

  createCodeExecution(input: { id: string; runId: string; code: string }): CodeExecutionRecord {
    const now = nowIso();
    this.db
      .query(
        `INSERT INTO code_executions
          (id, run_id, code, status, result_json, error, finished_at, created_at, updated_at)
         VALUES (?, ?, ?, 'running', NULL, NULL, NULL, ?, ?)`,
      )
      .run(input.id, input.runId, input.code, now, now);
    return this.getCodeExecution(input.id) as CodeExecutionRecord;
  }

  getCodeExecution(id: string): CodeExecutionRecord | null {
    const row = this.db.query("SELECT * FROM code_executions WHERE id = ?").get(id) as Row | null;
    return row ? mapCodeExecution(row) : null;
  }

  listCodeExecutions(runId: string): CodeExecutionRecord[] {
    const rows = this.db
      .query("SELECT * FROM code_executions WHERE run_id = ? ORDER BY created_at ASC")
      .all(runId) as Row[];
    return rows.map(mapCodeExecution);
  }

  updateCodeExecution(
    id: string,
    input: {
      status: CodeExecutionRecord["status"];
      result?: unknown;
      error?: string | null;
    },
  ): CodeExecutionRecord {
    this.db
      .query(
        `UPDATE code_executions
         SET status = ?, result_json = ?, error = ?, updated_at = ?,
             finished_at = CASE WHEN ? IN ('succeeded', 'failed', 'cancelled') THEN ? ELSE NULL END
         WHERE id = ?`,
      )
      .run(
        input.status,
        input.result === undefined ? null : JSON.stringify(input.result),
        input.error ?? null,
        nowIso(),
        input.status,
        nowIso(),
        id,
      );
    const record = this.getCodeExecution(id);
    if (!record) throw new Error(`Code execution not found: ${id}`);
    return record;
  }

  upsertCodeExecutionCall(input: {
    executionId: string;
    callIndex: number;
    toolPath: string;
    arguments: unknown;
    result: unknown;
    status: "succeeded" | "failed";
  }): CodeExecutionCallRecord {
    this.db
      .query(
        `INSERT INTO code_execution_calls
          (execution_id, call_index, tool_path, arguments_json, result_json, status)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(execution_id, call_index) DO UPDATE SET
           tool_path = excluded.tool_path,
           arguments_json = excluded.arguments_json,
           result_json = excluded.result_json,
           status = excluded.status`,
      )
      .run(
        input.executionId,
        input.callIndex,
        input.toolPath,
        JSON.stringify(input.arguments),
        input.result === undefined ? null : JSON.stringify(input.result),
        input.status,
      );
    return {
      executionId: input.executionId,
      callIndex: input.callIndex,
      toolPath: input.toolPath,
      arguments: input.arguments,
      result: input.result,
      status: input.status,
    };
  }

  listCodeExecutionCalls(executionId: string): CodeExecutionCallRecord[] {
    const rows = this.db
      .query(
        `SELECT * FROM code_execution_calls
         WHERE execution_id = ?
         ORDER BY call_index ASC`,
      )
      .all(executionId) as Row[];
    return rows.map((row) => ({
      executionId: asString(row.execution_id),
      callIndex: Number(row.call_index ?? 0),
      toolPath: asString(row.tool_path),
      arguments: parseJson<unknown>(row.arguments_json, null),
      result: parseJson<unknown>(row.result_json, null),
      status: asString(row.status) as CodeExecutionCallRecord["status"],
    }));
  }

  openDiscussBatch(input: {
    conversationId: string;
    botId: string;
    messageId: string;
    debounceMs: number;
    maxWaitMs: number;
  }): DiscussBatchRecord {
    return this.db.transaction(() => {
      const now = Date.now();
      const existing = this.db
        .query(
          `SELECT * FROM discuss_batches
           WHERE conversation_id = ? AND bot_id = ? AND status = 'open'`,
        )
        .get(input.conversationId, input.botId) as Row | null;
      let batch: DiscussBatchRecord;
      if (existing) {
        const current = mapDiscussBatch(existing);
        const dueAt = new Date(
          Math.min(now + input.debounceMs, new Date(current.hardDeadlineAt).getTime()),
        ).toISOString();
        this.db.query("UPDATE discuss_batches SET due_at = ? WHERE id = ?").run(dueAt, current.id);
        batch = { ...current, dueAt };
      } else {
        const openedAt = new Date(now).toISOString();
        batch = {
          id: createId("discuss"),
          conversationId: input.conversationId,
          botId: input.botId,
          runId: null,
          status: "open",
          openedAt,
          dueAt: new Date(now + input.debounceMs).toISOString(),
          hardDeadlineAt: new Date(now + input.maxWaitMs).toISOString(),
          processedAt: null,
        };
        this.db
          .query(
            `INSERT INTO discuss_batches
              (id, conversation_id, bot_id, status, opened_at, due_at, hard_deadline_at, processed_at)
             VALUES (?, ?, ?, 'open', ?, ?, ?, NULL)`,
          )
          .run(
            batch.id,
            batch.conversationId,
            batch.botId,
            batch.openedAt,
            batch.dueAt,
            batch.hardDeadlineAt,
          );
      }
      this.db
        .query(
          `INSERT INTO discuss_batch_messages (batch_id, message_id)
           VALUES (?, ?)
           ON CONFLICT DO NOTHING`,
        )
        .run(batch.id, input.messageId);
      return batch;
    })();
  }

  listDueDiscussBatches(limit = 20): DiscussBatchRecord[] {
    const rows = this.db
      .query(
        `SELECT * FROM discuss_batches
         WHERE status = 'open' AND due_at <= ?
         ORDER BY due_at ASC
         LIMIT ?`,
      )
      .all(nowIso(), Math.max(1, Math.min(limit, 100))) as Row[];
    return rows.map(mapDiscussBatch);
  }

  listDiscussBatchMessages(batchId: string): MessageRecord[] {
    const rows = this.db
      .query(
        `SELECT messages.*
         FROM messages
         JOIN discuss_batch_messages ON discuss_batch_messages.message_id = messages.id
         WHERE discuss_batch_messages.batch_id = ?
         ORDER BY messages.created_at ASC, messages.id ASC`,
      )
      .all(batchId) as Row[];
    return rows.map(mapMessage);
  }

  listDiscussBatches(conversationId?: string, limit = 20): DiscussBatchRecord[] {
    const capped = Math.max(1, Math.min(limit, 100));
    const rows = conversationId
      ? (this.db
          .query(
            `SELECT * FROM discuss_batches
             WHERE conversation_id = ?
             ORDER BY opened_at DESC LIMIT ?`,
          )
          .all(conversationId, capped) as Row[])
      : (this.db
          .query("SELECT * FROM discuss_batches ORDER BY opened_at DESC LIMIT ?")
          .all(capped) as Row[]);
    return rows.map(mapDiscussBatch);
  }

  listDiscussDecisions(conversationId?: string, limit = 50): DiscussDecisionRecord[] {
    const capped = Math.max(1, Math.min(limit, 200));
    const rows = conversationId
      ? (this.db
          .query(
            `SELECT * FROM discuss_decisions
             WHERE conversation_id = ?
             ORDER BY created_at DESC LIMIT ?`,
          )
          .all(conversationId, capped) as Row[])
      : (this.db
          .query("SELECT * FROM discuss_decisions ORDER BY created_at DESC LIMIT ?")
          .all(capped) as Row[]);
    return rows.map(mapDiscussDecision);
  }

  getDiscussDecisionForBatch(batchId: string): DiscussDecisionRecord | null {
    const row = this.db
      .query(
        `SELECT * FROM discuss_decisions
         WHERE batch_id = ?
         ORDER BY created_at ASC
         LIMIT 1`,
      )
      .get(batchId) as Row | null;
    return row ? mapDiscussDecision(row) : null;
  }

  finishDiscussBatch(input: {
    batchId: string;
    action: "send" | "silent";
    reason: string;
    confidence: number;
    model?: string | null;
    messageIds: string[];
    runId?: string | null;
  }): DiscussDecisionRecord {
    return this.db.transaction(() => {
      const now = nowIso();
      const row = this.db
        .query("SELECT * FROM discuss_batches WHERE id = ?")
        .get(input.batchId) as Row | null;
      if (!row) throw new Error(`Discuss batch not found: ${input.batchId}`);
      const batch = mapDiscussBatch(row);
      const existing = this.getDiscussDecisionForBatch(input.batchId);
      if (existing) {
        if (!existing.runId && input.runId) {
          this.db
            .query(
              `UPDATE discuss_decisions SET run_id = ?
               WHERE id = ? AND run_id IS NULL`,
            )
            .run(input.runId, existing.id);
          this.db
            .query(
              `UPDATE discuss_batches SET run_id = COALESCE(run_id, ?)
               WHERE id = ?`,
            )
            .run(input.runId, input.batchId);
          return this.getDiscussDecisionForBatch(input.batchId) ?? existing;
        }
        return existing;
      }
      this.db
        .query(
          `UPDATE discuss_batches SET status = 'processed', processed_at = ?, run_id = ?
           WHERE id = ?`,
        )
        .run(now, input.runId ?? null, input.batchId);
      const decision: DiscussDecisionRecord = {
        id: createId("decision"),
        conversationId: batch.conversationId,
        botId: batch.botId,
        runId: input.runId ?? null,
        action: input.action,
        reason: input.reason,
        confidence: input.confidence,
        model: input.model ?? null,
        messageIds: input.messageIds,
        createdAt: now,
      };
      this.db
        .query(
          `INSERT INTO discuss_decisions
            (id, batch_id, conversation_id, bot_id, run_id, action, reason, confidence, model,
             message_ids_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          decision.id,
          input.batchId,
          decision.conversationId,
          decision.botId,
          decision.runId,
          decision.action,
          decision.reason,
          decision.confidence,
          decision.model,
          JSON.stringify(decision.messageIds),
          decision.createdAt,
        );
      return decision;
    })();
  }

  recoverDiscussBatches(): DiscussBatchRecord[] {
    this.db
      .query(
        `UPDATE discuss_batches SET status = 'open'
         WHERE status = 'processing'`,
      )
      .run();
    return this.listDueDiscussBatches();
  }

  closeOpenDiscussBatch(conversationId: string, botId: string, reason: string): void {
    this.db.transaction(() => {
      const row = this.db
        .query(
          `SELECT * FROM discuss_batches
           WHERE conversation_id = ? AND bot_id = ? AND status = 'open'`,
        )
        .get(conversationId, botId) as Row | null;
      if (!row) return;
      const batch = mapDiscussBatch(row);
      const now = nowIso();
      this.db
        .query(
          `UPDATE discuss_batches SET status = 'processed', processed_at = ?
           WHERE id = ? AND status = 'open'`,
        )
        .run(now, batch.id);
      const messageIds = this.listDiscussBatchMessages(batch.id).map((message) => message.id);
      this.db
        .query(
          `INSERT INTO discuss_decisions
            (id, batch_id, conversation_id, bot_id, run_id, action, reason, confidence, model,
             message_ids_json, created_at)
           VALUES (?, ?, ?, ?, NULL, 'silent', ?, 1, NULL, ?, ?)`,
        )
        .run(
          createId("decision"),
          batch.id,
          batch.conversationId,
          batch.botId,
          reason,
          JSON.stringify(messageIds),
          now,
        );
    })();
  }

  listMcpServers(includeDisabled = false): McpServerRecord[] {
    const rows = this.db
      .query(
        `SELECT * FROM mcp_servers
         ${includeDisabled ? "" : "WHERE enabled = 1"}
         ORDER BY name COLLATE NOCASE ASC`,
      )
      .all() as Row[];
    return rows.map(mapMcpServer);
  }

  upsertMcpServer(input: {
    id: string;
    name: string;
    transport: "stdio" | "http";
    command?: string | null;
    args?: string[];
    url?: string | null;
    envRefs?: Record<string, string>;
    headers?: Record<string, string>;
    enabled?: boolean;
  }): McpServerRecord {
    const now = nowIso();
    this.db
      .query(
        `INSERT INTO mcp_servers
          (id, name, transport, command, args_json, url, env_refs_json, headers_json,
           enabled, status, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'disconnected', NULL, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           transport = excluded.transport,
           command = excluded.command,
           args_json = excluded.args_json,
           url = excluded.url,
           env_refs_json = excluded.env_refs_json,
           headers_json = excluded.headers_json,
           enabled = excluded.enabled,
           status = 'disconnected',
           last_error = NULL,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.id,
        input.name,
        input.transport,
        input.command ?? null,
        JSON.stringify(input.args ?? []),
        input.url ?? null,
        JSON.stringify(input.envRefs ?? {}),
        JSON.stringify(input.headers ?? {}),
        input.enabled === false ? 0 : 1,
        now,
        now,
      );
    return this.getMcpServer(input.id) as McpServerRecord;
  }

  getMcpServer(id: string): McpServerRecord | null {
    const row = this.db.query("SELECT * FROM mcp_servers WHERE id = ?").get(id) as Row | null;
    return row ? mapMcpServer(row) : null;
  }

  deleteMcpServer(id: string): boolean {
    return this.db.query("DELETE FROM mcp_servers WHERE id = ?").run(id).changes > 0;
  }

  updateMcpServerStatus(id: string, status: string, lastError?: string | null): void {
    this.db
      .query(`UPDATE mcp_servers SET status = ?, last_error = ?, updated_at = ? WHERE id = ?`)
      .run(status, lastError ?? null, nowIso(), id);
  }

  setMcpToolPolicy(serverId: string, toolName: string, policy: "auto" | "ask" | "deny"): void {
    this.db
      .query(
        `INSERT INTO mcp_tool_policies (server_id, tool_name, policy)
         VALUES (?, ?, ?)
         ON CONFLICT(server_id, tool_name) DO UPDATE SET policy = excluded.policy`,
      )
      .run(serverId, toolName, policy);
  }

  getMcpToolPolicy(serverId: string, toolName: string): "auto" | "ask" | "deny" {
    const row = this.db
      .query(`SELECT policy FROM mcp_tool_policies WHERE server_id = ? AND tool_name = ?`)
      .get(serverId, toolName) as Row | null;
    const policy = asString(row?.policy, "ask");
    return policy === "auto" || policy === "deny" ? policy : "ask";
  }

  listMcpToolPolicies(serverId?: string): McpToolPolicyRecord[] {
    const rows = serverId
      ? (this.db
          .query(
            `SELECT * FROM mcp_tool_policies
             WHERE server_id = ?
             ORDER BY tool_name COLLATE NOCASE ASC`,
          )
          .all(serverId) as Row[])
      : (this.db
          .query(
            `SELECT * FROM mcp_tool_policies
             ORDER BY server_id ASC, tool_name COLLATE NOCASE ASC`,
          )
          .all() as Row[]);
    return rows.map((row) => ({
      serverId: asString(row.server_id),
      toolName: asString(row.tool_name),
      policy: asString(row.policy, "ask") as McpToolPolicyRecord["policy"],
    }));
  }

  listPlugins(): PluginRecord[] {
    const rows = this.db
      .query("SELECT * FROM plugins ORDER BY name COLLATE NOCASE ASC, id ASC")
      .all() as Row[];
    return rows.map(mapPlugin);
  }

  getPlugin(id: string): PluginRecord | null {
    const row = this.db.query("SELECT * FROM plugins WHERE id = ?").get(id) as Row | null;
    return row ? mapPlugin(row) : null;
  }

  upsertDiscoveredPlugin(input: {
    id: string;
    name: string;
    version: string;
    description: string;
    author?: string | null;
    entryPath: string;
    source?: string;
    manifest: Record<string, unknown>;
    error?: string | null;
  }): PluginRecord {
    const existing = this.getPlugin(input.id);
    const now = nowIso();
    if (existing) {
      const status = input.error ? "error" : existing.enabled ? existing.status : "disabled";
      this.db
        .query(
          `UPDATE plugins SET
             name = ?, version = ?, description = ?, author = ?, entry_path = ?,
             source = ?, status = ?, manifest_json = ?, last_error = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.name,
          input.version,
          input.description,
          input.author ?? null,
          input.entryPath,
          input.source ?? "local",
          status,
          JSON.stringify(input.manifest),
          input.error ?? null,
          now,
          input.id,
        );
    } else {
      this.db
        .query(
          `INSERT INTO plugins
            (id, name, version, description, author, entry_path, source, enabled, status,
             manifest_json, last_error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.name,
          input.version,
          input.description,
          input.author ?? null,
          input.entryPath,
          input.source ?? "local",
          input.error ? "error" : "disabled",
          JSON.stringify(input.manifest),
          input.error ?? null,
          now,
          now,
        );
    }
    const record = this.getPlugin(input.id);
    if (!record) throw new Error(`Plugin write failed: ${input.id}`);
    return record;
  }

  setPluginEnabled(id: string, enabled: boolean): PluginRecord {
    this.db
      .query("UPDATE plugins SET enabled = ?, status = ?, updated_at = ? WHERE id = ?")
      .run(enabled ? 1 : 0, enabled ? "loading" : "disabled", nowIso(), id);
    const record = this.getPlugin(id);
    if (!record) throw new Error(`Plugin not found: ${id}`);
    return record;
  }

  updatePluginStatus(id: string, status: PluginStatus, lastError: string | null = null): void {
    this.db
      .query("UPDATE plugins SET status = ?, last_error = ?, updated_at = ? WHERE id = ?")
      .run(status, lastError, nowIso(), id);
  }

  setPluginToolPolicy(pluginId: string, toolName: string, policy: "auto" | "ask" | "deny"): void {
    this.db
      .query(
        `INSERT INTO plugin_tool_policies (plugin_id, tool_name, policy)
         VALUES (?, ?, ?)
         ON CONFLICT(plugin_id, tool_name) DO UPDATE SET policy = excluded.policy`,
      )
      .run(pluginId, toolName, policy);
  }

  getPluginToolPolicy(pluginId: string, toolName: string): "auto" | "ask" | "deny" {
    const row = this.db
      .query("SELECT policy FROM plugin_tool_policies WHERE plugin_id = ? AND tool_name = ?")
      .get(pluginId, toolName) as Row | null;
    const policy = asString(row?.policy, "ask");
    return policy === "auto" || policy === "deny" ? policy : "ask";
  }

  listPluginToolPolicies(pluginId?: string): PluginToolPolicyRecord[] {
    const rows = pluginId
      ? (this.db
          .query(
            `SELECT * FROM plugin_tool_policies
             WHERE plugin_id = ?
             ORDER BY tool_name COLLATE NOCASE ASC`,
          )
          .all(pluginId) as Row[])
      : (this.db
          .query(
            `SELECT * FROM plugin_tool_policies
             ORDER BY plugin_id ASC, tool_name COLLATE NOCASE ASC`,
          )
          .all() as Row[]);
    return rows.map((row) => ({
      pluginId: asString(row.plugin_id),
      toolName: asString(row.tool_name),
      policy: asString(row.policy, "ask") as PluginToolPolicyRecord["policy"],
    }));
  }

  getChannelSession(channelId: string, accountId: string): ChannelSessionRecord | null {
    const row = this.db
      .query(
        `SELECT * FROM channel_sessions
         WHERE channel_id = ? AND account_id = ?`,
      )
      .get(channelId, accountId) as Row | null;
    if (!row) return null;
    return {
      channelId: asString(row.channel_id),
      accountId: asString(row.account_id),
      sessionId: asString(row.session_id),
      lastSeq: Number(row.last_seq ?? 0),
      updatedAt: asString(row.updated_at),
    };
  }

  saveChannelSession(input: {
    channelId: string;
    accountId: string;
    sessionId: string;
    lastSeq: number;
  }): void {
    this.db
      .query(
        `INSERT INTO channel_sessions
          (channel_id, account_id, session_id, last_seq, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(channel_id, account_id) DO UPDATE SET
           session_id = excluded.session_id,
           last_seq = excluded.last_seq,
           updated_at = excluded.updated_at`,
      )
      .run(input.channelId, input.accountId, input.sessionId, input.lastSeq, nowIso());
  }

  clearChannelSession(channelId: string, accountId: string): void {
    this.db
      .query("DELETE FROM channel_sessions WHERE channel_id = ? AND account_id = ?")
      .run(channelId, accountId);
  }

  listSchedules(includeDisabled = true): ScheduleRecord[] {
    const rows = this.db
      .query(
        `SELECT * FROM schedules
         ${includeDisabled ? "" : "WHERE enabled = 1"}
         ORDER BY created_at ASC`,
      )
      .all() as Row[];
    return rows.map(mapSchedule);
  }

  listSubagentTasks(parentRunId: string): SubagentTaskRecord[] {
    const rows = this.db
      .query(
        `SELECT * FROM subagent_tasks
         WHERE parent_run_id = ?
         ORDER BY created_at ASC`,
      )
      .all(parentRunId) as Row[];
    return rows.map(mapSubagentTask);
  }

  getSubagentTask(id: string): SubagentTaskRecord | null {
    const row = this.db.query("SELECT * FROM subagent_tasks WHERE id = ?").get(id) as Row | null;
    return row ? mapSubagentTask(row) : null;
  }

  createSubagentTask(input: {
    parentRunId: string;
    botId: string;
    prompt: string;
    deadlineAt: string;
    maxConcurrent: number;
    maxTotal: number;
  }): SubagentTaskRecord {
    const id = createId("subtask");
    const now = nowIso();
    this.db.transaction(() => {
      const parent = this.db
        .query("SELECT state, trigger_kind FROM runs WHERE id = ?")
        .get(input.parentRunId) as Row | null;
      if (!parent) throw new Error(`Parent run not found: ${input.parentRunId}`);
      if (asString(parent.state) !== "running") {
        throw new Error("Sub Agents can only be spawned by a running parent run");
      }
      if (asString(parent.trigger_kind) === "subagent") {
        throw new Error("Sub Agents cannot spawn nested Sub Agents");
      }
      const counts = this.db
        .query(
          `SELECT
             SUM(CASE WHEN status IN ('queued', 'running') THEN 1 ELSE 0 END) AS active,
             COUNT(*) AS total
           FROM subagent_tasks WHERE parent_run_id = ?`,
        )
        .get(input.parentRunId) as Row;
      if (Number(counts.active ?? 0) >= input.maxConcurrent) {
        throw new Error(`Sub Agent concurrency limit reached (${input.maxConcurrent})`);
      }
      if (Number(counts.total ?? 0) >= input.maxTotal) {
        throw new Error(`Sub Agent total limit reached (${input.maxTotal})`);
      }
      this.db
        .query(
          `INSERT INTO subagent_tasks
            (id, parent_run_id, bot_id, prompt, status, deadline_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
        )
        .run(id, input.parentRunId, input.botId, input.prompt, input.deadlineAt, now, now);
    })();
    const task = this.getSubagentTask(id);
    if (!task) throw new Error("Sub Agent task write failed");
    return task;
  }

  updateSubagentTask(
    id: string,
    input: {
      childRunId?: string | null;
      status?: SubagentTaskStatus;
      result?: unknown;
      error?: string | null;
      startedAt?: string | null;
      finishedAt?: string | null;
    },
  ): SubagentTaskRecord {
    const current = this.getSubagentTask(id);
    if (!current) throw new Error(`Sub Agent task not found: ${id}`);
    this.db
      .query(
        `UPDATE subagent_tasks
         SET child_run_id = ?, status = ?, result_json = ?, error = ?,
             started_at = ?, finished_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.childRunId === undefined ? current.childRunId : input.childRunId,
        input.status ?? current.status,
        input.result === undefined ? JSON.stringify(current.result) : JSON.stringify(input.result),
        input.error === undefined ? current.error : input.error,
        input.startedAt === undefined ? current.startedAt : input.startedAt,
        input.finishedAt === undefined ? current.finishedAt : input.finishedAt,
        nowIso(),
        id,
      );
    const updated = this.getSubagentTask(id);
    if (!updated) throw new Error("Sub Agent task disappeared after update");
    return updated;
  }

  listAgentMessages(rootRunId: string): AgentMessageRecord[] {
    const rows = this.db
      .query(
        `SELECT * FROM agent_messages
         WHERE root_run_id = ?
         ORDER BY created_at ASC`,
      )
      .all(rootRunId) as Row[];
    return rows.map(mapAgentMessage);
  }

  getAgentMessage(id: string): AgentMessageRecord | null {
    const row = this.db.query("SELECT * FROM agent_messages WHERE id = ?").get(id) as Row | null;
    return row ? mapAgentMessage(row) : null;
  }

  findAgentMessageByDedupeKey(dedupeKey: string): AgentMessageRecord | null {
    const row = this.db
      .query("SELECT * FROM agent_messages WHERE dedupe_key = ? LIMIT 1")
      .get(dedupeKey) as Row | null;
    return row ? mapAgentMessage(row) : null;
  }

  findAgentMessageByTargetRunId(targetRunId: string): AgentMessageRecord | null {
    const row = this.db
      .query("SELECT * FROM agent_messages WHERE target_run_id = ? LIMIT 1")
      .get(targetRunId) as Row | null;
    return row ? mapAgentMessage(row) : null;
  }

  createAgentMessage(input: {
    sourceRunId: string;
    rootRunId: string;
    sourceBotId: string;
    targetBotId: string;
    prompt: string;
    hopCount: number;
    dedupeKey: string;
    maxHops: number;
    maxPerParent: number;
  }): AgentMessageRecord {
    const id = createId("agentmsg");
    const now = nowIso();
    this.db.transaction(() => {
      if (input.hopCount > input.maxHops) {
        throw new Error(`Cross-Bot hop limit reached (${input.maxHops})`);
      }
      const source = this.db
        .query("SELECT state, trigger_kind, bot_id FROM runs WHERE id = ?")
        .get(input.sourceRunId) as Row | null;
      if (!source) throw new Error(`Cross-Bot source run not found: ${input.sourceRunId}`);
      if (asString(source.state) !== "running") {
        throw new Error("Cross-Bot dispatch requires a running source run");
      }
      if (asString(source.trigger_kind) === "subagent") {
        throw new Error("Sub Agents cannot dispatch messages to other Bots");
      }
      if (asString(source.bot_id) !== input.sourceBotId) {
        throw new Error("Cross-Bot source Bot does not match the source run");
      }
      if (this.findAgentMessageByDedupeKey(input.dedupeKey)) {
        throw new Error("Duplicate or looping cross-Bot dispatch");
      }
      const counts = this.db
        .query("SELECT COUNT(*) AS count FROM agent_messages WHERE source_run_id = ?")
        .get(input.sourceRunId) as Row;
      if (Number(counts.count ?? 0) >= input.maxPerParent) {
        throw new Error(`Cross-Bot dispatch limit reached (${input.maxPerParent})`);
      }
      this.db
        .query(
          `INSERT INTO agent_messages
            (id, source_run_id, root_run_id, source_bot_id, target_bot_id,
             prompt, hop_count, status, dedupe_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
        )
        .run(
          id,
          input.sourceRunId,
          input.rootRunId,
          input.sourceBotId,
          input.targetBotId,
          input.prompt,
          input.hopCount,
          input.dedupeKey,
          now,
          now,
        );
    })();
    const message = this.getAgentMessage(id);
    if (!message) throw new Error("Cross-Bot message write failed");
    return message;
  }

  updateAgentMessage(
    id: string,
    input: {
      targetRunId?: string | null;
      status?: AgentMessageStatus;
      result?: unknown;
      error?: string | null;
      startedAt?: string | null;
      finishedAt?: string | null;
    },
  ): AgentMessageRecord {
    const current = this.getAgentMessage(id);
    if (!current) throw new Error(`Cross-Bot message not found: ${id}`);
    this.db
      .query(
        `UPDATE agent_messages
         SET target_run_id = ?, status = ?, result_json = ?, error = ?,
             started_at = ?, finished_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.targetRunId === undefined ? current.targetRunId : input.targetRunId,
        input.status ?? current.status,
        input.result === undefined ? JSON.stringify(current.result) : JSON.stringify(input.result),
        input.error === undefined ? current.error : input.error,
        input.startedAt === undefined ? current.startedAt : input.startedAt,
        input.finishedAt === undefined ? current.finishedAt : input.finishedAt,
        nowIso(),
        id,
      );
    const updated = this.getAgentMessage(id);
    if (!updated) throw new Error("Cross-Bot message disappeared after update");
    return updated;
  }

  recoverOrchestrationAfterRestart(): {
    subagentTasks: number;
    agentMessages: number;
  } {
    const finishedAt = nowIso();
    return this.db.transaction(() => {
      const subagentTasks = this.db
        .query(
          `UPDATE subagent_tasks
           SET status = 'failed',
               error = COALESCE(error, 'FinalBot restarted while this Sub Agent was active.'),
               finished_at = COALESCE(finished_at, ?),
               updated_at = ?
           WHERE status IN ('queued', 'running')`,
        )
        .run(finishedAt, finishedAt).changes;
      const agentMessages = this.db
        .query(
          `UPDATE agent_messages
           SET status = 'failed',
               error = COALESCE(error, 'FinalBot restarted while this Cross-Bot dispatch was active.'),
               finished_at = COALESCE(finished_at, ?),
               updated_at = ?
           WHERE status IN ('queued', 'running')`,
        )
        .run(finishedAt, finishedAt).changes;
      return {
        subagentTasks: Number(subagentTasks),
        agentMessages: Number(agentMessages),
      };
    })();
  }

  getSchedule(id: string): ScheduleRecord | null {
    const row = this.db.query("SELECT * FROM schedules WHERE id = ?").get(id) as Row | null;
    return row ? mapSchedule(row) : null;
  }

  createSchedule(input: {
    id: string;
    name: string;
    expression: string;
    timezone: string;
    conversationId: string;
    botId: string;
    prompt: string;
    nextRunAt: string;
  }): ScheduleRecord {
    const now = nowIso();
    this.db
      .query(
        `INSERT INTO schedules
          (id, name, expression, timezone, conversation_id, bot_id, prompt,
           enabled, next_run_at, last_run_at, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        input.id,
        input.name,
        input.expression,
        input.timezone,
        input.conversationId,
        input.botId,
        input.prompt,
        input.nextRunAt,
        now,
        now,
      );
    return this.getSchedule(input.id) as ScheduleRecord;
  }

  updateSchedule(
    id: string,
    input: {
      enabled?: boolean;
      nextRunAt?: string | null;
      lastRunAt?: string | null;
      lastError?: string | null;
    },
  ): ScheduleRecord {
    const current = this.getSchedule(id);
    if (!current) throw new Error(`Schedule not found: ${id}`);
    this.db
      .query(
        `UPDATE schedules SET
           enabled = ?, next_run_at = ?, last_run_at = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        (input.enabled ?? current.enabled) ? 1 : 0,
        input.nextRunAt === undefined ? current.nextRunAt : input.nextRunAt,
        input.lastRunAt === undefined ? current.lastRunAt : input.lastRunAt,
        input.lastError === undefined ? current.lastError : input.lastError,
        nowIso(),
        id,
      );
    return this.getSchedule(id) as ScheduleRecord;
  }

  listDueSchedules(now = nowIso()): ScheduleRecord[] {
    const rows = this.db
      .query(
        `SELECT * FROM schedules
         WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
         ORDER BY next_run_at ASC`,
      )
      .all(now) as Row[];
    return rows.map(mapSchedule);
  }
}
