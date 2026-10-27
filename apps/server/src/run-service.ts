import type {
  AgentAdapter,
  AgentEvent,
  AgentRunHandle,
  ApprovalDecision,
  InboundMessage,
  PendingApproval,
} from "@finalbot/core";
import { createId, nowIso, type RunState } from "@finalbot/core";
import { CodexAgentAdapter } from "@finalbot/agent-codex";
import type {
  ApprovalRecord,
  FinalBotDatabase,
  RunRecord,
} from "@finalbot/db";
import { GitWorkspaceManager } from "@finalbot/workspace-git";
import type { AppConfig } from "./config";
import { ApprovalBroker } from "./approval-broker";
import { EventBus } from "./event-bus";

type ReplySender = (target: Record<string, unknown>, text: string) => Promise<void>;

export class RunService {
  private readonly agent: AgentAdapter & { close?: () => Promise<void> };
  private readonly approvals = new ApprovalBroker();
  private readonly activeHandles = new Map<string, AgentRunHandle>();
  private readonly activeConversations = new Set<string>();
  private readonly workspace: GitWorkspaceManager | null;
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private replySender: ReplySender | null = null;

  constructor(
    private readonly db: FinalBotDatabase,
    private readonly bus: EventBus,
    private readonly config: AppConfig,
  ) {
    this.agent = config.fakeAgent ? new DemoAgentAdapter() : new CodexAgentAdapter({
      executable: config.codex.executable,
      ...(config.codex.model ? { model: config.codex.model } : {}),
    });
    this.workspace = config.repositoryPath
      ? new GitWorkspaceManager(config.repositoryPath, config.worktreesDir)
      : null;
  }

  setReplySender(sender: ReplySender): void {
    this.replySender = sender;
  }

  async validateWorkspace(): Promise<void> {
    await this.workspace?.validate();
  }

  async admitInbound(message: InboundMessage): Promise<void> {
    const conversation = this.db.upsertConversation({
      channel: message.channel,
      accountId: message.accountId,
      externalId: message.externalConversationId,
      conversationKind: message.conversationKind,
      metadata: { replyTarget: message.replyTarget },
    });
    const admitted = this.db.admitInbound({
      conversationId: conversation.id,
      externalMessageId: message.externalMessageId,
      senderId: message.senderId,
      text: message.text,
      raw: message.raw,
      receivedAt: message.receivedAt,
    });
    if (admitted.duplicate) return;
    this.scheduleConversation(conversation.id);
  }

  private scheduleConversation(conversationId: string): void {
    if (this.activeConversations.has(conversationId)) return;
    const existing = this.debounceTimers.get(conversationId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(conversationId);
      void this.drainConversation(conversationId);
    }, 350);
    this.debounceTimers.set(conversationId, timer);
  }

  private async drainConversation(conversationId: string): Promise<void> {
    if (this.activeConversations.has(conversationId)) return;
    if (this.db.countActiveRuns() >= this.config.maxConcurrentRuns) {
      this.scheduleConversation(conversationId);
      return;
    }
    const items = this.db.getPendingInbox(conversationId);
    if (items.length === 0) return;
    this.activeConversations.add(conversationId);
    const ids = items.map((item) => item.id);
    this.db.markInboxRunning(ids);

    const prompt = items.map((item) => item.text).join("\n");
    const conversation = this.db.getConversation(conversationId);
    const replyTarget =
      conversation && typeof conversation.metadata.replyTarget === "object"
        ? (conversation.metadata.replyTarget as Record<string, unknown>)
        : null;
    const run = this.db.createRun({
      conversationId,
      prompt,
      agent: "codex",
      replyTarget,
    });
    this.publishRun(run);

    try {
      const result = await this.executeRun(run);
      if (result.state === "succeeded") {
        this.db.markInboxDone(conversationId, ids);
      } else {
        this.db.markInboxFailed(ids);
      }
      if (replyTarget && this.replySender) {
        const message =
          result.state === "succeeded"
            ? result.output.trim() || "任务已完成。"
            : `任务${result.state === "interrupted" ? "已中断" : "失败"}：${
                result.error ?? "未提供错误信息"
              }`;
        await this.replySender(replyTarget, message).catch(() => undefined);
      }
    } finally {
      this.activeConversations.delete(conversationId);
      if (this.db.getPendingInbox(conversationId).length > 0) {
        this.scheduleConversation(conversationId);
      }
    }
  }

  async createWebRun(prompt: string): Promise<RunRecord> {
    if (!this.workspace) {
      throw new Error("FINALBOT_REPO_PATH is not configured");
    }
    const conversation = this.db.upsertConversation({
      channel: "web",
      accountId: "local",
      externalId: "main",
      conversationKind: "private",
      title: "FinalBot Web",
      metadata: { replyTarget: { kind: "web" } },
    });
    const run = this.db.createRun({
      conversationId: conversation.id,
      prompt,
      agent: "codex",
      replyTarget: { kind: "web" },
    });
    this.publishRun(run);
    void this.executeRun(run).catch(() => undefined);
    return run;
  }

  private async executeRun(run: RunRecord): Promise<RunRecord> {
    if (!this.workspace) {
      const failed = this.db.updateRun(run.id, {
        state: "failed",
        error: "FINALBOT_REPO_PATH is not configured",
        finishedAt: nowIso(),
      });
      this.publishRun(failed);
      return failed;
    }

    let current = this.db.updateRun(run.id, {
      state: "running",
      startedAt: nowIso(),
    });
    this.publishRun(current);
    this.db.putPhase({
      runId: run.id,
      phase: "workspace",
      status: "running",
      checkpoint: { repositoryPath: this.config.repositoryPath },
    });

    try {
      const worktree = await this.workspace.create(run.id);
      current = this.db.updateRun(run.id, { workspacePath: worktree.path });
      this.db.putPhase({
        runId: run.id,
        phase: "workspace",
        status: "done",
        checkpoint: { path: worktree.path, baseCommit: worktree.baseCommit },
      });
      this.db.putPhase({
        runId: run.id,
        phase: "agent.start",
        status: "running",
        checkpoint: { cwd: worktree.path },
      });

      const handle = this.agent.start(
        {
          runId: run.id,
          prompt: run.prompt,
          cwd: worktree.path,
          ...(this.config.codex.model ? { model: this.config.codex.model } : {}),
          sandbox: this.config.codex.sandbox,
        },
        {
          event: async (event) => this.handleAgentEvent(run.id, event),
          requestApproval: async (request) => this.requestApproval(run.id, request),
        },
      );
      this.activeHandles.set(run.id, handle);
      const result = await handle.result;

      const state: RunState =
        result.status === "succeeded"
          ? "succeeded"
          : result.status === "interrupted"
            ? "interrupted"
            : result.status === "cancelled"
              ? "cancelled"
              : "failed";
      const terminal = state === "succeeded" || state === "failed" || state === "cancelled";
      current = this.db.updateRun(run.id, {
        state,
        nativeThreadId: result.nativeThreadId || current.nativeThreadId,
        nativeTurnId: result.nativeTurnId || current.nativeTurnId,
        ...(result.error ? { error: result.error } : {}),
        ...(terminal ? { finishedAt: nowIso() } : {}),
      });
      this.db.putPhase({
        runId: run.id,
        phase: "agent",
        status: result.status,
        checkpoint: {
          nativeThreadId: result.nativeThreadId,
          nativeTurnId: result.nativeTurnId,
        },
      });
      this.publishRun(current);
      return current;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      current = this.db.updateRun(run.id, {
        state: "failed",
        error: message,
        finishedAt: nowIso(),
      });
      this.db.putPhase({
        runId: run.id,
        phase: "agent",
        status: "failed",
        checkpoint: { error: message },
      });
      this.publishRun(current);
      return current;
    } finally {
      this.activeHandles.delete(run.id);
    }
  }

  private async handleAgentEvent(runId: string, event: AgentEvent): Promise<void> {
    const run = this.db.getRun(runId);
    if (!run) return;
    if (event.type === "thread") {
      const updated = this.db.updateRun(runId, { nativeThreadId: event.nativeThreadId });
      this.publishRun(updated);
      return;
    }
    if (event.type === "turn") {
      const updated = this.db.updateRun(runId, { nativeTurnId: event.nativeTurnId });
      this.publishRun(updated);
      return;
    }
    if (event.type === "delta") {
      const updated = this.db.updateRun(runId, { outputAppend: event.text });
      this.bus.publish({
        type: "run.delta",
        runId,
        text: event.text,
        at: nowIso(),
      });
      void updated;
      return;
    }
    if (event.type === "warning") {
      this.bus.publish({
        type: "system",
        level: "warning",
        message: event.message,
        at: nowIso(),
      });
    }
  }

  private async requestApproval(
    runId: string,
    request: Omit<PendingApproval, "runId">,
  ): Promise<ApprovalDecision> {
    const record = this.db.createApproval({
      requestId: request.requestId,
      runId,
      kind: request.kind,
      title: request.title,
      detail: request.detail,
      payload: request.payload,
    });
    const run = this.db.getRun(runId);
    if (run?.state === "running") {
      const waiting = this.db.updateRun(runId, { state: "waiting_approval" });
      this.publishRun(waiting);
    }
    this.publishApproval(record, "approval.requested");
    const decision = await this.approvals.wait(request.requestId);
    const resolved = this.db.resolveApproval(request.requestId, decision);
    this.publishApproval(resolved, "approval.resolved");
    const after = this.db.getRun(runId);
    if (after?.state === "waiting_approval") {
      const resumed = this.db.updateRun(runId, { state: "running" });
      this.publishRun(resumed);
    }
    return decision;
  }

  resolveApproval(requestId: string, decision: ApprovalDecision): ApprovalRecord {
    const record = this.db.getApproval(requestId);
    if (!record) throw new Error(`Approval not found: ${requestId}`);
    if (record.status !== "pending") return record;
    const resolved = this.db.resolveApproval(requestId, decision);
    this.approvals.resolve(requestId, decision);
    this.publishApproval(resolved, "approval.resolved");
    return resolved;
  }

  async interrupt(runId: string): Promise<void> {
    const run = this.db.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    const handle = this.activeHandles.get(runId);
    if (handle) {
      await handle.interrupt();
      return;
    }
    if (run.state === "admitted" || run.state === "waiting_approval" || run.state === "retrying") {
      const updated = this.db.updateRun(runId, {
        state: "cancelled",
        finishedAt: nowIso(),
      });
      this.publishRun(updated);
    }
  }

  private publishRun(run: RunRecord): void {
    this.bus.publish({
      type: "run.updated",
      run: {
        id: run.id,
        state: run.state,
        prompt: run.prompt,
        agent: run.agent,
        output: run.output,
        error: run.error,
        nativeThreadId: run.nativeThreadId,
        nativeTurnId: run.nativeTurnId,
        workspacePath: run.workspacePath,
        conversationId: run.conversationId,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      },
      at: nowIso(),
    });
  }

  private publishApproval(
    approval: ApprovalRecord,
    type: "approval.requested" | "approval.resolved",
  ): void {
    this.bus.publish({
      type,
      approval: {
        requestId: approval.requestId,
        runId: approval.runId,
        kind: approval.kind,
        title: approval.title,
        detail: approval.detail,
        status: approval.status,
        createdAt: approval.createdAt,
        resolvedAt: approval.resolvedAt,
      },
      at: nowIso(),
    });
  }

  async recover(): Promise<void> {
    const runs = this.db.recoverActiveRuns();
    for (const run of runs) this.publishRun(run);
  }

  async close(): Promise<void> {
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    this.approvals.cancelAll();
    await this.agent.close?.();
  }
}

export function createRunId(): string {
  return createId("run");
}

class DemoAgentAdapter implements AgentAdapter {
  start(
    input: Parameters<AgentAdapter["start"]>[0],
    sink: Parameters<AgentAdapter["start"]>[1],
  ): AgentRunHandle {
    const nativeThreadId = createId("demo_thread");
    const nativeTurnId = createId("demo_turn");
    let interrupted = false;
    const result = (async () => {
      await sink.event({ type: "thread", nativeThreadId });
      await sink.event({ type: "turn", nativeTurnId });
      const text = `FinalBot demo completed the request in ${input.cwd}.\n\n${input.prompt}`;
      for (const chunk of text.match(/.{1,32}/gs) ?? []) {
        if (interrupted) break;
        await Bun.sleep(25);
        await sink.event({ type: "delta", text: chunk });
      }
      return {
        status: interrupted ? ("interrupted" as const) : ("succeeded" as const),
        nativeThreadId,
        nativeTurnId,
        output: text,
      };
    })();
    return {
      result,
      interrupt: async () => {
        interrupted = true;
      },
    };
  }
}

