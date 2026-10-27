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

export const TERMINAL_RUN_STATES = ["succeeded", "failed", "cancelled"] as const;
export type TerminalRunState = (typeof TERMINAL_RUN_STATES)[number];

export type ChannelKind = "web" | "onebot";
export type ConversationKind = "private" | "group" | "channel";
export type AgentKind = "codex" | "opencode" | "claude-code";

export interface InboundMessage {
  channel: ChannelKind;
  accountId: string;
  externalConversationId: string;
  conversationKind: ConversationKind;
  externalMessageId: string;
  senderId: string;
  text: string;
  raw: unknown;
  receivedAt: string;
  replyTarget: OneBotReplyTarget | WebReplyTarget;
}

export interface OneBotReplyTarget {
  kind: "onebot";
  messageType: "private" | "group";
  userId?: string;
  groupId?: string;
}

export interface WebReplyTarget {
  kind: "web";
}

export interface ApprovalDecision {
  action: "accept" | "accept_session" | "decline" | "cancel";
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
  nativeThreadId?: string;
  model?: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
}

export interface AgentRunResult {
  status: "succeeded" | "failed" | "interrupted" | "cancelled";
  nativeThreadId: string;
  nativeTurnId: string;
  output: string;
  error?: string;
}

export interface AgentRunHandle {
  readonly result: Promise<AgentRunResult>;
  interrupt(): Promise<void>;
}

export interface AgentSink {
  event(event: AgentEvent): void | Promise<void>;
  requestApproval(request: Omit<PendingApproval, "runId">): Promise<ApprovalDecision>;
}

export interface AgentAdapter {
  start(input: AgentRunInput, sink: AgentSink): AgentRunHandle;
}

