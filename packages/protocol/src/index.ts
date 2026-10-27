import type { ApprovalDecision, RunState } from "@finalbot/core";

export interface RunSummary {
  id: string;
  state: RunState;
  prompt: string;
  requestedBy: string | null;
  agent: string;
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
  onebot: {
    configured: boolean;
    connected: boolean;
    accountId: string | null;
  };
  repository: {
    configured: boolean;
    path: string | null;
  };
}

export interface CreateRunRequest {
  prompt: string;
}

export interface ResolveApprovalRequest extends ApprovalDecision {}

export interface ApiError {
  error: string;
  message: string;
}
