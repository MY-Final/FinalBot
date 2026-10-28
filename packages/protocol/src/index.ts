import type { ApprovalDecision, ChannelCapabilities, ChannelState, RunState } from "@finalbot/core";

export interface RunSummary {
  id: string;
  state: RunState;
  prompt: string;
  requestedBy: string | null;
  botId: string;
  botName: string;
  agent: string;
  model: string | null;
  output: string;
  error: string | null;
  nativeThreadId: string | null;
  nativeTurnId: string | null;
  workspacePath: string | null;
  conversationId: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ApprovalSummary {
  requestId: string;
  runId: string;
  kind: string;
  title: string;
  detail: string;
  canAcceptForSession: boolean;
  status: "pending" | "accepted" | "declined" | "cancelled" | "expired";
  createdAt: string;
  resolvedAt: string | null;
}

export interface RunDetail extends RunSummary {
  approvals: ApprovalSummary[];
  messages: Array<{
    id: string;
    role: "user" | "assistant" | "system";
    senderId: string | null;
    senderName: string | null;
    text: string;
    createdAt: string;
  }>;
  toolCalls: ToolCallSummary[];
  discussDecisions: DiscussDecisionSummary[];
  phases: Array<{
    phase: string;
    attempt: number;
    status: string;
    checkpoint: unknown;
    updatedAt: string;
  }>;
}

export type ServerEvent =
  | {
      type: "run.updated";
      run: RunSummary;
      at: string;
    }
  | {
      type: "run.delta";
      runId: string;
      text: string;
      at: string;
    }
  | {
      type: "approval.requested";
      approval: ApprovalSummary;
      at: string;
    }
  | {
      type: "approval.resolved";
      approval: ApprovalSummary;
      at: string;
    }
  | {
      type: "system";
      level: "info" | "warning" | "error";
      message: string;
      at: string;
    };

export interface HealthResponse {
  ok: boolean;
  version: string;
  uptimeSeconds: number;
  channels: ChannelState[];
  repository: {
    configured: boolean;
    path: string | null;
  };
}

export interface CreateRunRequest {
  prompt: string;
  botId?: string;
}

export interface BotSummary {
  id: string;
  name: string;
  description: string;
  agent: string;
  model: string | null;
  enabled: boolean;
  workspaceMode: "git-worktree" | "shared-directory" | "none";
}

export interface MemorySummary {
  id: string;
  scope: "owner" | "bot";
  botId: string | null;
  kind: string;
  content: string;
  tags: string[];
  confidence: number;
  status: "active" | "deleted";
  createdAt: string;
  updatedAt: string;
}

export interface ChannelSummary extends ChannelState {
  capabilities: ChannelCapabilities;
}

export interface ToolSummary {
  namespace: string;
  name: string;
  description: string;
  policy: "auto" | "ask" | "deny";
}

export interface ScheduleSummary {
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
}

export interface ConversationPolicySummary {
  conversationId: string;
  observeAll: boolean;
  discussEnabled: boolean;
  updatedAt: string;
}

export interface ConversationSummary {
  id: string;
  channel: string;
  accountId: string;
  externalId: string;
  conversationKind: "private" | "group" | "channel" | "thread";
  title: string | null;
  activeBotId: string;
  createdAt: string;
  updatedAt: string;
  policy: ConversationPolicySummary;
}

export interface ScratchpadSummary {
  conversationId: string;
  botId: string;
  content: unknown;
  revision: number;
  expiresAt: string;
  updatedAt: string;
}

export interface McpToolSummary {
  name: string;
  description: string;
  policy: "auto" | "ask" | "deny";
}

export interface McpServerSummary {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command: string | null;
  args: string[];
  url: string | null;
  enabled: boolean;
  status: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  envRefs: Record<string, string>;
  headers: Record<string, string>;
  envRefsConfigured: Record<string, boolean>;
  headersConfigured: Record<string, boolean>;
  tools: McpToolSummary[];
  policies: Array<{
    serverId: string;
    toolName: string;
    policy: "auto" | "ask" | "deny";
  }>;
}

export interface PluginToolSummary {
  name: string;
  description: string;
  policy: "auto" | "ask" | "deny";
}

export interface PluginSummary {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string | null;
  source: string;
  enabled: boolean;
  status: "disabled" | "loading" | "active" | "error" | "missing";
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  tools: PluginToolSummary[];
  events: string[];
}

export interface ToolCallSummary {
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

export interface DiscussDecisionSummary {
  id: string;
  conversationId: string;
  botId: string;
  action: "send" | "silent";
  reason: string;
  confidence: number;
  model: string | null;
  messageIds: string[];
  createdAt: string;
}

export interface ResolveApprovalRequest extends ApprovalDecision {}

export interface ApiError {
  error: string;
  message: string;
}
