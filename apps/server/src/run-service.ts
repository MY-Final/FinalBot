import { CodexAgentAdapter } from "@finalbot/agent-codex";
import type {
  AgentAdapter,
  AgentEvent,
  AgentRunHandle,
  ApprovalDecision,
  InboundMessage,
  OneBotReplyTarget,
  PendingApproval,
  WebReplyTarget,
} from "@finalbot/core";
import {
  createId,
  type ImCommand,
  isTerminalRunState,
  nowIso,
  parseImCommand,
  type RunState,
} from "@finalbot/core";
import type { ApprovalRecord, FinalBotDatabase, RunRecord } from "@finalbot/db";
import type { ServerEvent } from "@finalbot/protocol";
import { GitWorkspaceManager } from "@finalbot/workspace-git";
import { ApprovalBroker } from "./approval-broker";
import type { AppConfig } from "./config";
import type { EventBus } from "./event-bus";

type ReplyTarget = OneBotReplyTarget | WebReplyTarget;
type ReplySender = (target: ReplyTarget, text: string) => Promise<void>;

interface ReplyContext {
  conversationId: string;
  senderId: string;
  replyTarget: ReplyTarget | null;
}

export class RunService {
  private readonly agent: AgentAdapter & { close?: () => Promise<void> };
  private readonly approvals = new ApprovalBroker();
  private readonly activeHandles = new Map<string, AgentRunHandle>();
  private readonly activeConversations = new Set<string>();
  private readonly interruptRequested = new Set<string>();
  private readonly workspace: GitWorkspaceManager | null;
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly outboxInFlight = new Set<string>();
  private readonly outboxTimer: ReturnType<typeof setInterval>;
  private closed = false;
  private replySender: ReplySender | null = null;

  constructor(
    private readonly db: FinalBotDatabase,
    private readonly bus: EventBus,
    private readonly config: AppConfig,
    agent?: AgentAdapter & { close?: () => Promise<void> },
  ) {
    this.agent =
      agent ??
      (config.fakeAgent
        ? new DemoAgentAdapter()
        : new CodexAgentAdapter({
            executable: config.codex.executable,
            ...(config.codex.model ? { model: config.codex.model } : {}),
          }));
    this.workspace = config.repositoryPath
      ? new GitWorkspaceManager(config.repositoryPath, config.worktreesDir)
      : null;
    this.outboxTimer = setInterval(() => void this.flushOutbox(), 5_000);
    this.outboxTimer.unref?.();
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

    const command = parseImCommand(message.text);
    if (command) {
      await this.handleCommand(message, command);
      return;
    }
    const admitted = this.db.admitInbound({
      conversationId: conversation.id,
      externalMessageId: message.externalMessageId,
      botId: conversation.activeBotId,
      senderId: message.senderId,
      text: message.text,
      raw: message.raw,
      receivedAt: message.receivedAt,
    });
    if (admitted.duplicate) return;
    if (this.closed) return;
    this.scheduleConversation(conversation.id);
  }

  private async handleCommand(message: InboundMessage, command: ImCommand): Promise<void> {
    const conversation = this.db.getConversationByExternal(
      message.channel,
      message.accountId,
      message.externalConversationId,
    );
    if (!conversation) {
      await this.reply(message.replyTarget, "无法找到当前会话。");
      return;
    }
    const context: ReplyContext = {
      conversationId: conversation.id,
      senderId: message.senderId,
      replyTarget: message.replyTarget,
    };

    if (command.kind === "help") {
      await this.reply(
        message.replyTarget,
        [
          "FinalBot 指令",
          "/status - 查看当前任务",
          "/approve [审批ID] - 允许本次",
          "/approve_session [审批ID] - 本会话允许",
          "/deny [审批ID] - 拒绝",
          "/cancel - 中断当前任务",
          "/bots - 查看可用 Bot",
          "/use <bot> - 切换当前会话 Bot",
          "/bot <bot> <任务> - 本次派发给指定 Bot",
        ].join("\n"),
      );
      return;
    }
    if (command.kind === "unknown") {
      await this.reply(
        message.replyTarget,
        `无法识别指令：${command.raw}\n发送 /help 查看可用指令。`,
      );
      return;
    }
    if (command.kind === "status") {
      await this.sendStatus(context);
      return;
    }
    if (command.kind === "cancel") {
      await this.cancelForConversation(context);
      return;
    }
    if (command.kind === "bots") {
      await this.sendBots(context);
      return;
    }
    if (command.kind === "use") {
      await this.useBot(context, command.bot);
      return;
    }
    if (command.kind === "bot") {
      await this.dispatchToBot(message, command.bot, command.prompt);
      return;
    }
    const requestId = "requestId" in command ? command.requestId : undefined;

    const run = this.findRunForCommand(context, requestId);
    if (!run) {
      await this.reply(message.replyTarget, "当前会话没有可操作的任务。");
      return;
    }
    const approval = this.findApprovalForCommand(run.id, requestId);
    if (!approval) {
      await this.reply(message.replyTarget, "没有找到待审批操作。");
      return;
    }
    if (command.kind === "approve_session" && !approval.canAcceptForSession) {
      await this.reply(message.replyTarget, "该操作不支持本会话放行，请使用 /approve。");
      return;
    }
    const decision: ApprovalDecision =
      command.kind === "deny"
        ? { action: "decline" }
        : command.kind === "approve_session"
          ? { action: "accept_session" }
          : { action: "accept" };
    try {
      this.assertApprovalOwner(approval, context.senderId);
      this.resolveApproval(approval.requestId, decision);
      const verb =
        command.kind === "deny"
          ? "已拒绝"
          : command.kind === "approve_session"
            ? "本会话已允许"
            : "已允许";
      await this.reply(
        message.replyTarget,
        `${verb}：${approval.title}\n审批 ID：${approval.requestId}`,
      );
    } catch (error) {
      await this.reply(
        message.replyTarget,
        `审批操作失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async sendBots(context: ReplyContext): Promise<void> {
    const conversation = this.db.getConversation(context.conversationId);
    if (!conversation) return;
    const bots = this.db.listBotProfiles();
    if (bots.length === 0) {
      await this.reply(context.replyTarget, "当前没有启用的 Bot。");
      return;
    }
    const lines = [
      "可用 Bot",
      ...bots.map(
        (bot) =>
          `${bot.id === conversation.activeBotId ? "*" : "-"} ${bot.id} / ${bot.name} / ${bot.agent}${
            bot.description ? ` - ${bot.description}` : ""
          }`,
      ),
      "",
      `当前：${conversation.activeBotId}`,
      "使用 /use <bot> 切换，或 /bot <bot> <任务> 单次派发。",
    ];
    await this.reply(context.replyTarget, lines.join("\n"));
  }

  private async useBot(context: ReplyContext, botId: string): Promise<void> {
    const bot = this.db.getBotProfile(botId);
    if (!bot?.enabled) {
      await this.reply(context.replyTarget, `Bot 不存在或未启用：${botId}`);
      return;
    }
    if (this.activeConversations.has(context.conversationId)) {
      await this.reply(context.replyTarget, "当前会话还有任务正在执行，请等任务结束后再切换 Bot。");
      return;
    }
    this.db.setConversationActiveBot(context.conversationId, bot.id);
    await this.reply(context.replyTarget, `当前会话已切换到：${bot.name} (${bot.id})`);
  }

  private async dispatchToBot(
    message: InboundMessage,
    botId: string,
    prompt: string,
  ): Promise<void> {
    const bot = this.db.getBotProfile(botId);
    if (!bot?.enabled) {
      await this.reply(message.replyTarget, `Bot 不存在或未启用：${botId}`);
      return;
    }
    const conversation = this.db.getConversationByExternal(
      message.channel,
      message.accountId,
      message.externalConversationId,
    );
    if (!conversation) return;
    const admitted = this.db.admitInbound({
      conversationId: conversation.id,
      externalMessageId: message.externalMessageId,
      botId: bot.id,
      senderId: message.senderId,
      text: prompt,
      raw: message.raw,
      receivedAt: message.receivedAt,
    });
    if (admitted.duplicate || this.closed) return;
    this.scheduleConversation(conversation.id);
  }

  private async sendStatus(context: ReplyContext): Promise<void> {
    const run = this.db.getLatestRun(context.conversationId);
    if (!run) {
      await this.reply(context.replyTarget, "当前会话还没有任务。");
      return;
    }
    try {
      this.assertRunOwner(run, context.senderId);
    } catch {
      await this.reply(context.replyTarget, "当前任务不属于当前发送者。");
      return;
    }
    const approvals = this.db.listPendingApprovals(run.id);
    const lines = [
      `任务：${run.id}`,
      `Bot：${run.botName} (${run.botId})`,
      `状态：${run.state}`,
      run.model ? `模型：${run.model}` : null,
      run.workspacePath ? `工作区：${run.workspacePath}` : null,
      run.error ? `错误：${run.error}` : null,
      approvals.length > 0
        ? `待审批：${approvals
            .map((approval) => `${approval.title} (${approval.requestId})`)
            .join(" / ")}`
        : "待审批：无",
    ].filter((line): line is string => line !== null);
    await this.reply(context.replyTarget, lines.join("\n"));
  }

  private async cancelForConversation(context: ReplyContext): Promise<void> {
    const run = this.db.getLatestRun(context.conversationId);
    if (!run || isTerminalRunState(run.state)) {
      await this.reply(context.replyTarget, "当前没有可中断的任务。");
      return;
    }
    try {
      this.assertRunOwner(run, context.senderId);
      await this.interrupt(run.id);
      await this.reply(context.replyTarget, `已请求中断任务：${run.id}`);
    } catch (error) {
      await this.reply(
        context.replyTarget,
        `中断失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private findRunForCommand(context: ReplyContext, requestId?: string): RunRecord | null {
    try {
      if (requestId) {
        const approval = this.db.getApproval(requestId);
        if (!approval) return null;
        const run = this.db.getRun(approval.runId);
        if (!run || run.conversationId !== context.conversationId) return null;
        this.assertRunOwner(run, context.senderId);
        return run;
      }
      const run = this.db.getLatestRun(context.conversationId);
      if (!run) return null;
      this.assertRunOwner(run, context.senderId);
      return run;
    } catch {
      return null;
    }
  }

  private findApprovalForCommand(runId: string, requestId?: string): ApprovalRecord | null {
    if (requestId) {
      const approval = this.db.getApproval(requestId);
      return approval?.runId === runId && approval.status === "pending" ? approval : null;
    }
    return this.db.listPendingApprovals(runId)[0] ?? null;
  }

  private assertRunOwner(run: RunRecord, senderId: string): void {
    if (run.requestedBy && run.requestedBy !== senderId) {
      throw new Error("该任务不属于当前发送者");
    }
  }

  private assertApprovalOwner(approval: ApprovalRecord, senderId: string): void {
    const run = this.db.getRun(approval.runId);
    if (!run) throw new Error("审批对应的任务不存在");
    this.assertRunOwner(run, senderId);
  }

  private async reply(target: ReplyTarget | null, text: string): Promise<void> {
    if (!target) return;
    if (!this.replySender) return;
    const outboxId = this.db.enqueueOutbox("reply", { target, text });
    await this.deliverOutbox(outboxId, target, text);
  }

  async flushOutbox(): Promise<void> {
    if (!this.replySender) return;
    const pending = this.db.pendingOutbox();
    for (const item of pending) {
      if (item.type !== "reply" || this.outboxInFlight.has(item.id)) continue;
      const payload = parseReplyPayload(item.payload);
      if (!payload) {
        console.error(`[finalbot] invalid outbox payload: ${item.id}`);
        continue;
      }
      const delivered = await this.deliverOutbox(item.id, payload.target, payload.text);
      if (!delivered) break;
    }
  }

  private async deliverOutbox(id: string, target: ReplyTarget, text: string): Promise<boolean> {
    if (!this.replySender || this.outboxInFlight.has(id)) return false;
    this.outboxInFlight.add(id);
    try {
      await this.replySender(target, text);
      this.db.markOutboxDelivered(id);
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[finalbot] failed to send reply, will retry: ${detail}`);
      return false;
    } finally {
      this.outboxInFlight.delete(id);
    }
  }

  private scheduleConversation(conversationId: string): void {
    const existing = this.debounceTimers.get(conversationId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(conversationId);
      void this.drainConversation(conversationId);
    }, 350);
    this.debounceTimers.set(conversationId, timer);
  }

  private async drainConversation(conversationId: string): Promise<void> {
    if (this.closed) return;
    if (this.activeConversations.has(conversationId)) return;
    if (this.db.countActiveRuns() >= this.config.maxConcurrentRuns) {
      this.scheduleConversation(conversationId);
      return;
    }
    const first = this.db.getPendingInbox(conversationId)[0];
    if (!first) return;
    const items = this.db.getPendingInbox(conversationId, first.botId);
    if (items.length === 0) return;
    const bot = this.db.getBotProfile(first.botId);
    const conversation = this.db.getConversation(conversationId);
    const replyTarget =
      conversation && typeof conversation.metadata.replyTarget === "object"
        ? (conversation.metadata.replyTarget as ReplyTarget)
        : null;
    if (!bot?.enabled) {
      const ids = items.map((item) => item.id);
      this.db.markInboxFailed(ids);
      if (replyTarget) {
        await this.reply(replyTarget, `Bot 不存在或未启用：${first.botId}`);
      }
      // Give another bot's pending queue a fresh scheduling turn.
      if (!this.closed && this.db.getPendingInbox(conversationId).length > 0) {
        this.scheduleConversation(conversationId);
      }
      return;
    }
    this.activeConversations.add(conversationId);
    const ids = items.map((item) => item.id);
    this.db.markInboxRunning(ids);

    const prompt = items.map((item) => item.text).join("\n");
    const run = this.db.createRun({
      conversationId,
      prompt,
      requestedBy: items.at(-1)?.senderId ?? null,
      botId: bot.id,
      botName: bot.name,
      botInstructions: bot.instructions,
      agent: bot.agent,
      model: bot.model ?? this.config.codex.model,
      replyTarget,
    });
    const session = this.db.getLatestConversationSession(conversationId, bot.id);
    if (session?.nativeThreadId) {
      this.db.updateRun(run.id, { nativeThreadId: session.nativeThreadId });
    }
    this.publishRun(run);

    try {
      const result = await this.executeRun(run);
      if (result.state === "succeeded") {
        this.db.markInboxDone(conversationId, ids);
      } else {
        this.db.markInboxFailed(ids);
      }
      if (replyTarget) {
        const message =
          result.state === "succeeded"
            ? result.output.trim() || "任务已完成。"
            : result.state === "interrupted"
              ? "任务已中断。"
              : `任务失败：${result.error ?? "未提供错误信息"}`;
        await this.reply(replyTarget, message);
      }
    } finally {
      this.activeConversations.delete(conversationId);
      if (!this.closed && this.db.getPendingInbox(conversationId).length > 0) {
        this.scheduleConversation(conversationId);
      }
    }
  }

  async createWebRun(prompt: string, botId = "coder"): Promise<RunRecord> {
    if (!this.workspace) {
      throw new Error("FINALBOT_REPO_PATH is not configured");
    }
    const bot = this.db.getBotProfile(botId);
    if (!bot?.enabled) {
      throw new Error(`Bot 不存在或未启用：${botId}`);
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
      requestedBy: "web:local",
      botId: bot.id,
      botName: bot.name,
      botInstructions: bot.instructions,
      agent: bot.agent,
      model: bot.model ?? this.config.codex.model,
      replyTarget: { kind: "web" },
    });
    this.publishRun(run);
    void this.executeRun(run).catch(() => undefined);
    return run;
  }

  private async executeRun(run: RunRecord): Promise<RunRecord> {
    if (this.interruptRequested.has(run.id)) {
      return this.endBeforeStart(run.id);
    }
    if (!this.workspace) {
      const failed = this.db.updateRun(run.id, {
        state: "failed",
        error: "FINALBOT_REPO_PATH is not configured",
        finishedAt: nowIso(),
      });
      this.publishRun(failed);
      return failed;
    }
    if (run.agent !== "codex") {
      const failed = this.db.updateRun(run.id, {
        state: "failed",
        error: `Agent is not supported yet: ${run.agent}`,
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
      if (this.interruptRequested.has(run.id)) {
        return this.endBeforeStart(run.id);
      }
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
          ...(current.nativeThreadId ? { nativeThreadId: current.nativeThreadId } : {}),
          ...(run.model ? { model: run.model } : {}),
          ...(run.botInstructions ? { developerInstructions: run.botInstructions } : {}),
          sandbox: this.config.codex.sandbox,
        },
        {
          event: async (event) => this.handleAgentEvent(run.id, event),
          requestApproval: async (request) => this.requestApproval(run.id, request),
        },
      );
      this.activeHandles.set(run.id, handle);
      if (this.interruptRequested.has(run.id)) {
        await handle.interrupt();
      }
      const result = await handle.result;

      const state: RunState =
        result.status === "succeeded"
          ? "succeeded"
          : result.status === "interrupted"
            ? "interrupted"
            : result.status === "cancelled"
              ? "cancelled"
              : "failed";
      const ended =
        state === "succeeded" ||
        state === "failed" ||
        state === "cancelled" ||
        state === "interrupted";
      current = this.db.updateRun(run.id, {
        state,
        nativeThreadId: result.nativeThreadId || current.nativeThreadId,
        nativeTurnId: result.nativeTurnId || current.nativeTurnId,
        ...(result.error ? { error: result.error } : {}),
        ...(ended ? { finishedAt: nowIso() } : {}),
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
      this.interruptRequested.delete(run.id);
    }
  }

  private endBeforeStart(runId: string): RunRecord {
    this.interruptRequested.delete(runId);
    const current = this.db.getRun(runId);
    if (!current) throw new Error(`Run not found: ${runId}`);
    this.db.putPhase({
      runId,
      phase: "agent",
      status: "interrupted",
      checkpoint: { reason: "interrupted_before_agent_start" },
    });
    if (isTerminalRunState(current.state)) return current;
    const stopped = this.db.updateRun(runId, {
      state: current.state === "admitted" ? "cancelled" : "interrupted",
      finishedAt: nowIso(),
    });
    this.publishRun(stopped);
    return stopped;
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
      this.db.updateRun(runId, { outputAppend: event.text });
      this.emitEvent(runId, {
        type: "run.delta",
        runId,
        text: event.text,
        at: nowIso(),
      });
      return;
    }
    if (event.type === "warning") {
      this.emitEvent(runId, {
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
    const requestId = createId("approval");
    const record = this.db.createApproval({
      requestId,
      runId,
      kind: request.kind,
      title: request.title,
      detail: request.detail,
      canAcceptForSession: request.canAcceptForSession,
      payload: request.payload,
    });
    const run = this.db.getRun(runId);
    if (run?.state !== "running") {
      const cancelled = this.db.resolveApproval(requestId, { action: "cancel" });
      this.publishApproval(cancelled, "approval.resolved");
      return { action: "cancel" };
    }
    if (run?.state === "running") {
      const waiting = this.db.updateRun(runId, { state: "waiting_approval" });
      this.publishRun(waiting);
    }
    const decisionPromise = this.approvals.wait(requestId);
    this.publishApproval(record, "approval.requested");
    if (run.replyTarget) {
      await this.reply(run.replyTarget, formatApprovalNotice(record));
    }
    const decision = await decisionPromise;
    const resolved = this.db.resolveApproval(requestId, decision);
    if (decision.action !== "cancel") {
      this.publishApproval(resolved, "approval.resolved");
    }
    if (run.replyTarget && decision.action !== "cancel") {
      await this.reply(run.replyTarget, `审批已处理：${record.title} -> ${decision.action}`);
    }
    const after = this.db.getRun(runId);
    if (after?.state === "waiting_approval") {
      const resumed = this.db.updateRun(runId, { state: "running" });
      this.publishRun(resumed);
    }
    if (decision.action === "cancel" && after?.state !== "waiting_approval") {
      const interrupted = this.db.getRun(runId);
      if (interrupted && (interrupted.state === "running" || interrupted.state === "retrying")) {
        const next = this.db.updateRun(runId, {
          state: "interrupted",
          finishedAt: nowIso(),
        });
        this.publishRun(next);
      }
    }
    if (decision.action === "cancel") {
      this.publishApproval(resolved, "approval.resolved");
    }
    return decision;
  }

  resolveApproval(requestId: string, decision: ApprovalDecision): ApprovalRecord {
    const record = this.db.getApproval(requestId);
    if (!record) throw new Error(`Approval not found: ${requestId}`);
    if (record.status !== "pending") return record;
    const resolved = this.db.resolveApproval(requestId, decision);
    if (this.approvals.resolve(requestId, decision)) {
      // The waiting requestApproval callback owns the resolved event.
      return resolved;
    }
    this.publishApproval(resolved, "approval.resolved");
    return resolved;
  }

  async interrupt(runId: string): Promise<void> {
    const run = this.db.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (isTerminalRunState(run.state)) return;
    this.interruptRequested.add(runId);
    const pending = this.db.listPendingApprovals(runId);
    for (const approval of pending) {
      this.resolveApproval(approval.requestId, { action: "cancel" });
    }
    const handle = this.activeHandles.get(runId);
    if (handle) {
      await handle.interrupt();
      return;
    }
    if (
      run.state === "admitted" ||
      run.state === "running" ||
      run.state === "waiting_approval" ||
      run.state === "retrying"
    ) {
      const updated = this.db.updateRun(runId, {
        state: run.state === "admitted" ? "cancelled" : "interrupted",
        finishedAt: nowIso(),
      });
      this.publishRun(updated);
    }
  }

  private publishRun(run: RunRecord): void {
    this.emitEvent(run.id, {
      type: "run.updated",
      run: {
        id: run.id,
        state: run.state,
        prompt: run.prompt,
        requestedBy: run.requestedBy,
        botId: run.botId,
        botName: run.botName,
        agent: run.agent,
        model: run.model,
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
    this.emitEvent(approval.runId, {
      type,
      approval: {
        requestId: approval.requestId,
        runId: approval.runId,
        kind: approval.kind,
        title: approval.title,
        detail: approval.detail,
        canAcceptForSession: approval.canAcceptForSession,
        status: approval.status,
        createdAt: approval.createdAt,
        resolvedAt: approval.resolvedAt,
      },
      at: nowIso(),
    });
  }

  async recover(): Promise<void> {
    const recoveredRuns = this.db.recoverActiveRuns();
    const inbox = this.db.recoverQueueAfterRestart();
    for (const run of recoveredRuns) this.publishRun(run);
    if (recoveredRuns.length > 0 || inbox.failed > 0) {
      this.emitEvent(null, {
        type: "system",
        level: "warning",
        message: `Recovered after restart: ${recoveredRuns.length} run(s) interrupted, ${inbox.failed} message(s) marked failed, ${inbox.queues.length} conversation/bot queue(s) requeued.`,
        at: nowIso(),
      });
    }
    for (const conversationId of new Set(inbox.queues.map((queue) => queue.conversationId))) {
      this.scheduleConversation(conversationId);
    }
    await this.flushOutbox();
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.outboxTimer);
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    this.approvals.cancelAll();
    await this.agent.close?.();
  }

  private emitEvent(runId: string | null, event: ServerEvent): void {
    const record = this.db.appendEvent({
      runId,
      type: event.type,
      payload: event,
    });
    this.bus.publish({ seq: record.seq, event });
  }
}

export function createRunId(): string {
  return createId("run");
}

function formatApprovalNotice(approval: ApprovalRecord): string {
  const lines = [
    "需要审批",
    `任务：${approval.runId}`,
    `类型：${approval.kind}`,
    `事项：${approval.title}`,
    `详情：${truncate(approval.detail, 900)}`,
    `ID：${approval.requestId}`,
    "",
    "/approve - 允许本次",
    ...(approval.canAcceptForSession ? ["/approve_session - 本会话允许"] : []),
    "/deny - 拒绝",
    "/cancel - 中断任务",
  ];
  return lines.join("\n");
}

function truncate(value: string, max: number): string {
  const compact = value.trim();
  return compact.length > max ? `${compact.slice(0, max)}...` : compact;
}

function parseReplyPayload(payload: unknown): { target: ReplyTarget; text: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const candidate = payload as { target?: unknown; text?: unknown };
  if (
    !candidate.target ||
    typeof candidate.target !== "object" ||
    typeof candidate.text !== "string"
  ) {
    return null;
  }
  const target = candidate.target as Partial<ReplyTarget>;
  if (target.kind === "web") {
    return { target: { kind: "web" }, text: candidate.text };
  }
  if (
    target.kind === "onebot" &&
    (target.messageType === "group" || target.messageType === "private")
  ) {
    return { target: target as ReplyTarget, text: candidate.text };
  }
  return null;
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
