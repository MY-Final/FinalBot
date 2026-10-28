export const RUN_STATES = [
  "admitted",
  "running",
  "waiting_approval",
  "retrying",
  "interrupted",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type RunState = (typeof RUN_STATES)[number];

export const TERMINAL_RUN_STATES = ["succeeded", "failed", "cancelled", "interrupted"] as const;
export type TerminalRunState = (typeof TERMINAL_RUN_STATES)[number];

export type ChannelKind = string;
export type ConversationKind = "private" | "group" | "channel" | "thread";
export type AgentKind = "codex" | "opencode" | "claude-code";
export type WorkspaceMode = "git-worktree" | "shared-directory" | "none";
export type MessageRole = "user" | "assistant" | "system";
export type ToolPolicy = "auto" | "ask" | "deny";

export interface OutboundAddress {
  channelId: string;
  accountId: string;
  data: Record<string, unknown>;
}

export interface OutboundMessage {
  text: string;
  format: "text" | "markdown";
  replyToExternalMessageId?: string;
}

export interface SendResult {
  externalMessageId?: string;
  deliveredAt: string;
}

export interface ChannelCapabilities {
  observeAll: boolean;
  proactiveSend: boolean;
  reply: boolean;
  markdown: boolean;
  maxTextLength: number;
  maxRepliesPerInbound?: number;
}

export interface ChannelState {
  id: string;
  type: string;
  enabled: boolean;
  configured: boolean;
  connected: boolean;
  accountId: string | null;
  capabilities: ChannelCapabilities;
  lastError: string | null;
}

export interface InboundEnvelope {
  channelId: string;
  accountId: string;
  externalConversationId: string;
  conversationKind: ConversationKind;
  externalMessageId: string;
  senderId: string;
  senderName?: string;
  /**
   * Stable platform aliases for the sender. QQ reports different OpenIDs for
   * C2C and group events, while union_openid is shared by both.
   */
  senderAliases?: string[];
  text: string;
  mentions: Array<{ id: string; displayName?: string }>;
  botMentioned: boolean;
  botRepliedTo: boolean;
  replyToExternalMessageId?: string;
  receivedAt: string;
  replyAddress: OutboundAddress;
  raw: unknown;
}

export interface ChannelAdapter {
  readonly id: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  getState(): ChannelState;
  send(address: OutboundAddress, message: OutboundMessage): Promise<SendResult>;
}

export interface ApprovalDecision {
  action: "accept" | "accept_session" | "decline" | "cancel";
}

export interface DynamicToolSpec {
  type: "function";
  name: string;
  description: string;
  inputSchema: unknown;
  deferLoading?: boolean;
}

export interface DynamicToolCall {
  threadId: string;
  turnId: string;
  callId: string;
  namespace?: string | null;
  tool: string;
  arguments: unknown;
}

export interface DynamicToolResult {
  success: boolean;
  contentItems: Array<{ type: "inputText"; text: string }>;
}

export type AgentEvent =
  | { type: "thread"; nativeThreadId: string }
  | { type: "turn"; nativeTurnId: string }
  | { type: "delta"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; name: string; detail: string }
  | { type: "warning"; message: string };

export interface PendingApproval {
  requestId: string;
  runId: string;
  kind: "command" | "file_change" | "user_input" | "permissions" | "mcp";
  title: string;
  detail: string;
  canAcceptForSession: boolean;
  payload: unknown;
}

export interface AgentRunInput {
  runId: string;
  prompt: string;
  cwd: string;
  conversationId?: string;
  botId?: string;
  ownerId?: string | null;
  nativeThreadId?: string;
  model?: string;
  developerInstructions?: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  dynamicTools?: DynamicToolSpec[];
  outputSchema?: unknown;
}

export interface AgentRunResult {
  status: "succeeded" | "failed" | "interrupted" | "cancelled";
  nativeThreadId: string;
  nativeTurnId: string;
  output: string;
  structuredOutput?: unknown;
  error?: string;
}

export interface AgentRunHandle {
  readonly result: Promise<AgentRunResult>;
  interrupt(): Promise<void>;
}

export interface AgentSink {
  event(event: AgentEvent): void | Promise<void>;
  requestApproval(request: Omit<PendingApproval, "runId">): Promise<ApprovalDecision>;
  callTool?(call: DynamicToolCall): Promise<DynamicToolResult>;
}

export interface AgentAdapter {
  start(input: AgentRunInput, sink: AgentSink): AgentRunHandle;
}

export interface ToolInvocationContext {
  runId: string;
  conversationId: string;
  botId: string;
  ownerId: string | null;
  toolSnapshotHash?: string;
  requestApproval?: (request: Omit<PendingApproval, "runId">) => Promise<ApprovalDecision>;
  onToolApprovalWait?: (waiting: boolean) => void | Promise<void>;
}

export interface ToolDefinition {
  namespace: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  policy: ToolPolicy;
  execute(input: unknown, context: ToolInvocationContext): Promise<unknown>;
}

export interface CodeExecutionResult {
  success: boolean;
  output: unknown;
  logs: string[];
  toolCalls: Array<{
    path: string;
    arguments: unknown;
    result: unknown;
    replayed: boolean;
  }>;
  error?: string;
}

export interface CodeSandbox {
  run(input: {
    code: string;
    callTool(path: string, args: unknown): Promise<unknown>;
    journal?: Map<string, unknown>;
    onToolCall?: (call: {
      index: number;
      path: string;
      arguments: unknown;
      result: unknown;
      replayed: boolean;
    }) => void | Promise<void>;
  }): Promise<CodeExecutionResult>;
}

export interface ToolSnapshot {
  revision: number;
  hash: string;
  tools: ToolDefinition[];
}

export interface DiscussDecision {
  action: "send" | "silent";
  reason: string;
  confidence: number;
}

export interface ScheduleDefinition {
  id: string;
  name: string;
  expression: string;
  timezone: string;
  conversationId: string;
  botId: string;
  prompt: string;
  enabled: boolean;
}
