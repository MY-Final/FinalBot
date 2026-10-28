import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CodexAgentAdapter } from "@finalbot/agent-codex";
import type {
  AgentAdapter,
  AgentEvent,
  AgentRunHandle,
  ApprovalDecision,
  DynamicToolCall,
  DynamicToolResult,
  DynamicToolSpec,
  InboundEnvelope,
  OutboundAddress,
  OutboundMessage,
  PendingApproval,
  ToolSnapshot,
} from "@finalbot/core";
import {
  type ChannelRegistry,
  createId,
  type ImCommand,
  isTerminalRunState,
  nowIso,
  parseImCommand,
  type RunState,
} from "@finalbot/core";
import type { ApprovalRecord, ConversationRecord, FinalBotDatabase, RunRecord } from "@finalbot/db";
import type { ServerEvent } from "@finalbot/protocol";
import { GitWorkspaceManager } from "@finalbot/workspace-git";
import { ApprovalBroker } from "./approval-broker";
import type { AppConfig } from "./config";
import type { EventBus } from "./event-bus";
import { type OrchestrationLimits, OrchestrationService } from "./orchestration";

type ReplySender = (address: OutboundAddress, message: OutboundMessage) => Promise<void>;
type ReplyPlanner = (
  address: OutboundAddress,
  message: OutboundMessage,
) => { chunks: string[]; truncated: boolean };
type ReplyChunkSender = (
  address: OutboundAddress,
  message: OutboundMessage,
  chunks: Array<{ index: number; text: string }>,
) => Promise<Array<{ externalMessageId?: string; deliveredAt: string }>>;

interface ReplyContext {
  conversationId: string;
  senderId: string;
  senderAliases: string[];
  replyAddress: OutboundAddress | null;
  conversationKind: InboundEnvelope["conversationKind"];
}

export interface RunToolProvider {
  current(): ToolSnapshot;
  specs(snapshot?: ToolSnapshot): DynamicToolSpec[];
  call(
    input: { namespace?: string | null; tool: string; arguments: unknown },
    context: {
      runId: string;
      conversationId: string;
      botId: string;
      ownerId: string | null;
      requestApproval?: (request: Omit<PendingApproval, "runId">) => Promise<ApprovalDecision>;
    },
  ): Promise<DynamicToolResult>;
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
  private orchestrationService: OrchestrationService | null = null;
  private tools: RunToolProvider | null = null;
  private closed = false;
  private replySender: ReplySender | null = null;
  private replyPlanner: ReplyPlanner | null = null;
  private replyChunkSender: ReplyChunkSender | null = null;

  constructor(
    private readonly db: FinalBotDatabase,
    private readonly bus: EventBus,
    private readonly config: AppConfig,
    agent?: AgentAdapter & { close?: () => Promise<void> },
    private readonly orchestrationLimits: Partial<OrchestrationLimits> = {},
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
    this.outboxTimer = setInterval(() => void this.flushOutbox(false), 5_000);
    this.outboxTimer.unref?.();
  }

  setReplySender(sender: ReplySender): void {
    this.replySender = sender;
  }

  setReplyChannel(channels: ChannelRegistry): void {
    this.replyPlanner = (address, message) => channels.plan(address, message);
    this.replyChunkSender = (address, message, chunks) =>
      channels.sendChunks(address, message, chunks);
  }

  setToolProvider(tools: RunToolProvider): void {
    this.tools = tools;
  }

  agentForService(): AgentAdapter & { close?: () => Promise<void> } {
    return this.agent;
  }

  orchestration(): OrchestrationService {
    this.orchestrationService ??= new OrchestrationService(
      this.db,
      {
        executeSubagent: (runId) => this.executeSubagentRun(runId),
        executeCrossBot: (runId) => this.executeCrossBotRun(runId),
        interrupt: (runId) => this.interrupt(runId),
      },
      this.orchestrationLimits,
    );
    return this.orchestrationService;
  }

  async admitStoredMessages(
    conversationId: string,
    botId: string,
    messageIds: string[],
    trigger: "discuss" | "schedule" = "discuss",
    dispatchKey?: string,
  ): Promise<RunRecord | null> {
    const bot = this.db.getBotProfile(botId);
    if (!bot?.enabled) return null;
    const messages = messageIds
      .map((id) => this.db.getMessage(id))
      .filter((message): message is NonNullable<typeof message> => message !== null);
    if (messages.length === 0) return null;
    const conversation = this.db.getConversation(conversationId);
    if (!conversation) return null;
    if (dispatchKey) {
      const existing = this.db.getRunByDispatchKey(dispatchKey);
      if (existing) {
        this.db.linkRunMessages(
          existing.id,
          messages.map((message) => message.id),
        );
        return existing;
      }
    }
    const prompt = messages.map((message) => message.text).join("\n");
    const run = this.db.createRun({
      conversationId,
      prompt,
      requestedBy: messages.at(-1)?.senderId ?? null,
      botId: bot.id,
      botName: bot.name,
      botInstructions: bot.instructions,
      agent: bot.agent,
      model: bot.model ?? this.config.codex.model,
      replyAddress: conversation.metadata.replyAddress as OutboundAddress | null,
      trigger,
      ...(dispatchKey ? { dispatchKey } : {}),
      workspaceMode: bot.workspaceMode,
    });
    this.db.linkRunMessages(
      run.id,
      messages.map((message) => message.id),
    );
    this.publishRun(run);
    void this.executeRun(run);
    return run;
  }

  async validateWorkspace(): Promise<void> {
    await this.workspace?.validate();
  }

  private async prepareWorkspace(run: RunRecord): Promise<string> {
    if (run.workspaceMode === "none") {
      const path = join(this.config.dataDir, "scratch", run.id);
      await mkdir(path, { recursive: true });
      return path;
    }
    if (run.workspaceMode === "shared-directory") {
      const bot = this.db.getBotProfile(run.botId);
      const path = bot?.workspacePath ?? this.config.repositoryPath;
      if (!path) throw new Error(`Bot ${run.botId} has no shared workspace directory`);
      await mkdir(path, { recursive: true });
      return path;
    }
    if (!this.workspace) {
      throw new Error("FINALBOT_REPO_PATH is not configured for git-worktree mode");
    }
    return (await this.workspace.create(run.id)).path;
  }

  async admitInbound(message: InboundEnvelope): Promise<void> {
    const conversation = this.db.upsertConversation({
      channel: message.channelId,
      accountId: message.accountId,
      externalId: message.externalConversationId,
      conversationKind: message.conversationKind,
      metadata: { replyAddress: message.replyAddress },
    });

    const command = parseImCommand(message.text);
    if (command) {
      await this.handleCommand(message, command, conversation);
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
    this.db.insertMessage({
      conversationId: conversation.id,
      channelId: message.channelId,
      accountId: message.accountId,
      externalConversationId: message.externalConversationId,
      externalMessageId: message.externalMessageId,
      role: "user",
      senderId: message.senderId,
      senderName: message.senderName ?? null,
      text: message.text,
      raw: message.raw,
      replyAddress: message.replyAddress,
      replyToExternalMessageId: message.replyToExternalMessageId ?? null,
      metadata: { mentions: message.mentions, botMentioned: message.botMentioned },
      createdAt: message.receivedAt,
    });
    if (this.closed) return;
    this.scheduleConversation(conversation.id);
  }

  private async handleCommand(
    message: InboundEnvelope,
    command: ImCommand,
    _currentConversation: NonNullable<ReturnType<FinalBotDatabase["getConversation"]>>,
  ): Promise<void> {
    const conversation = this.db.getConversationByExternal(
      message.channelId,
      message.accountId,
      message.externalConversationId,
    );
    if (!conversation) {
      await this.reply(message.replyAddress, "无法找到当前会话。");
      return;
    }
    const context: ReplyContext = {
      conversationId: conversation.id,
      senderId: message.senderId,
      senderAliases: message.senderAliases ?? [],
      replyAddress: message.replyAddress,
      conversationKind: message.conversationKind,
    };

    if (command.kind === "help") {
      await this.reply(
        message.replyAddress,
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
        message.replyAddress,
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
      await this.reply(message.replyAddress, "当前会话没有可操作的任务。");
      return;
    }
    const approval = this.findApprovalForCommand(run.id, requestId);
    if (!approval) {
      await this.reply(message.replyAddress, "没有找到待审批操作。");
      return;
    }
    if (command.kind === "approve_session" && !approval.canAcceptForSession) {
      await this.reply(message.replyAddress, "该操作不支持本会话放行，请使用 /approve。");
      return;
    }
    const decision: ApprovalDecision =
      command.kind === "deny"
        ? { action: "decline" }
        : command.kind === "approve_session"
          ? { action: "accept_session" }
          : { action: "accept" };
    try {
      this.assertApprovalOwner(approval, context.senderId, context.senderAliases);
      this.resolveApproval(approval.requestId, decision);
      const verb =
        command.kind === "deny"
          ? "已拒绝"
          : command.kind === "approve_session"
            ? "本会话已允许"
            : "已允许";
      await this.reply(
        message.replyAddress,
        `${verb}：${approval.title}\n审批 ID：${approval.requestId}`,
      );
    } catch (error) {
      await this.reply(
        message.replyAddress,
        `审批操作失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async sendBots(context: ReplyContext): Promise<void> {
    const conversation = this.db.getConversation(context.conversationId);
    if (!conversation) return;
    const bots = this.db.listBotProfiles();
    if (bots.length === 0) {
      await this.reply(context.replyAddress, "当前没有启用的 Bot。");
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
    await this.reply(context.replyAddress, lines.join("\n"));
  }

  private async useBot(context: ReplyContext, botId: string): Promise<void> {
    const bot = this.db.getBotProfile(botId);
    if (!bot?.enabled) {
      await this.reply(context.replyAddress, `Bot 不存在或未启用：${botId}`);
      return;
    }
    if (this.activeConversations.has(context.conversationId)) {
      await this.reply(
        context.replyAddress,
        "当前会话还有任务正在执行，请等任务结束后再切换 Bot。",
      );
      return;
    }
    this.db.setConversationActiveBot(context.conversationId, bot.id);
    await this.reply(context.replyAddress, `当前会话已切换到：${bot.name} (${bot.id})`);
  }

  private async dispatchToBot(
    message: InboundEnvelope,
    botId: string,
    prompt: string,
  ): Promise<void> {
    const bot = this.db.getBotProfile(botId);
    if (!bot?.enabled) {
      await this.reply(message.replyAddress, `Bot 不存在或未启用：${botId}`);
      return;
    }
    const conversation = this.db.getConversationByExternal(
      message.channelId,
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
      await this.reply(context.replyAddress, "当前会话还没有任务。");
      return;
    }
    try {
      this.assertRunOwner(run, context.senderId, context.senderAliases);
    } catch {
      await this.reply(context.replyAddress, "当前任务不属于当前发送者。");
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
    await this.reply(context.replyAddress, lines.join("\n"));
  }

  private async cancelForConversation(context: ReplyContext): Promise<void> {
    const run = this.db.getLatestRun(context.conversationId);
    if (!run || isTerminalRunState(run.state)) {
      await this.reply(context.replyAddress, "当前没有可中断的任务。");
      return;
    }
    try {
      this.assertRunOwner(run, context.senderId, context.senderAliases);
      await this.interrupt(run.id);
      await this.reply(context.replyAddress, `已请求中断任务：${run.id}`);
    } catch (error) {
      await this.reply(
        context.replyAddress,
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
        this.assertRunOwner(run, context.senderId, context.senderAliases);
        return run;
      }
      const run = this.db.getLatestRun(context.conversationId);
      if (!run) return null;
      this.assertRunOwner(run, context.senderId, context.senderAliases);
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

  private assertRunOwner(run: RunRecord, senderId: string, senderAliases: string[] = []): void {
    const conversation = this.db.getConversation(run.conversationId);
    const owner = this.db.getOwner();
    const identities = owner ? this.db.listOwnerIdentities(owner.id) : [];
    if (conversation && identities.length > 0 && owner) {
      const identity = this.db.resolveOwnerIdentity({
        channelId: conversation.channel,
        accountId: conversation.accountId,
        senderId,
        conversationKind: conversation.conversationKind,
        aliases: senderAliases,
      });
      if (identity?.ownerId === owner.id) return;
    }
    // Keep legacy data usable until the single owner has paired an identity.
    if (identities.length === 0 && run.requestedBy === senderId) return;
    if (identities.length > 0) {
      throw new Error("该任务不属于当前发送者");
    }
    if (run.requestedBy && run.requestedBy !== senderId) {
      throw new Error("该任务不属于当前发送者");
    }
  }

  private assertApprovalOwner(
    approval: ApprovalRecord,
    senderId: string,
    senderAliases: string[] = [],
  ): void {
    const run = this.db.getRun(approval.runId);
    if (!run) throw new Error("审批对应的任务不存在");
    this.assertRunOwner(run, senderId, senderAliases);
  }

  private async reply(address: OutboundAddress | null, text: string): Promise<void> {
    if (!address) return;
    if (!this.replySender) return;
    const outboxId = this.db.enqueueOutbox("reply", { address, text });
    await this.deliverOutbox(outboxId, address, { text, format: "text" });
  }

  private ownerPrivateAddress(conversation: ConversationRecord): OutboundAddress | null {
    const stored = conversation.metadata.ownerPrivateAddress;
    if (isOutboundAddress(stored)) return stored;
    const owner = this.db.getOwner();
    if (!owner) return null;
    const channelIds = [...new Set([conversation.channel, "onebot"])];
    for (const channelId of channelIds) {
      const identity = this.db
        .listOwnerIdentities(owner.id)
        .find(
          (candidate) =>
            candidate.channelId === channelId && candidate.conversationKind === "private",
        );
      if (!identity) continue;
      if (identity.replyAddress) return identity.replyAddress;
      return {
        channelId: identity.channelId,
        accountId: identity.accountId,
        data:
          identity.channelId === "onebot"
            ? { messageType: "private", userId: identity.senderId }
            : { kind: "c2c", targetId: identity.senderId },
      };
    }
    return null;
  }

  async flushOutbox(force = true): Promise<void> {
    if (!this.replySender) return;
    const pending = this.db.pendingOutbox(100, force);
    for (const item of pending) {
      if (item.type !== "reply" || this.outboxInFlight.has(item.id)) continue;
      const payload = parseReplyPayload(item.payload);
      if (!payload) {
        console.error(`[finalbot] invalid outbox payload: ${item.id}`);
        continue;
      }
      const delivered = await this.deliverOutbox(item.id, payload.address, {
        text: payload.text,
        format: "text",
      });
      if (!delivered) break;
    }
  }

  private async deliverOutbox(
    id: string,
    address: OutboundAddress,
    message: OutboundMessage,
  ): Promise<boolean> {
    if (!this.replySender || this.outboxInFlight.has(id)) return false;
    this.outboxInFlight.add(id);
    try {
      this.db.markOutboxDelivering(id);
      const planned = this.replyPlanner?.(address, message) ?? {
        chunks: [message.text],
        truncated: false,
      };
      const chunks = this.db.ensureOutboxChunks(id, planned.chunks);
      for (const chunk of chunks) {
        if (chunk.status === "delivered") continue;
        this.db.markOutboxChunkDelivering(chunk.id);
        try {
          if (this.replyChunkSender) {
            const [result] = await this.replyChunkSender(
              address,
              {
                ...message,
                ...(chunk.index > 0 && message.replyToExternalMessageId
                  ? { replyToExternalMessageId: message.replyToExternalMessageId }
                  : {}),
              },
              [{ index: chunk.index, text: chunk.text }],
            );
            this.db.markOutboxChunkDelivered(chunk.id, result?.externalMessageId);
          } else {
            await this.replySender(address, { ...message, text: chunk.text });
            this.db.markOutboxChunkDelivered(chunk.id);
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.db.failOutboxChunk(chunk.id, detail, chunk.attempts + 1);
          throw error;
        }
      }
      this.db.markOutboxDelivered(id);
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const retryable = isRetryableDeliveryError(detail);
      this.db.failOutbox(id, detail, retryable);
      console.error(`[finalbot] failed to send reply (${retryable ? "retry" : "dead"}): ${detail}`);
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
    const replyAddress =
      conversation && isOutboundAddress(conversation.metadata.replyAddress)
        ? conversation.metadata.replyAddress
        : null;
    if (!bot?.enabled) {
      const ids = items.map((item) => item.id);
      this.db.markInboxFailed(ids);
      if (replyAddress) {
        await this.reply(replyAddress, `Bot 不存在或未启用：${first.botId}`);
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
      replyAddress,
      workspaceMode: bot.workspaceMode,
    });
    const runMessages = this.db
      .listMessages(conversationId, 100)
      .filter((stored) =>
        ids.some(
          (id) =>
            stored.externalMessageId === items.find((item) => item.id === id)?.externalMessageId,
        ),
      )
      .map((stored) => stored.id);
    this.db.linkRunMessages(run.id, runMessages);
    const sessionRun = this.inheritConversationSession(run, prompt);
    this.publishRun(sessionRun);

    try {
      const result = await this.executeRun(run);
      if (result.state === "succeeded") {
        this.db.markInboxDone(conversationId, ids);
      } else {
        this.db.markInboxFailed(ids);
      }
      if (replyAddress) {
        const conversationKind = conversation?.conversationKind ?? "private";
        const message =
          result.state === "succeeded"
            ? result.output.trim() || "任务已完成。"
            : result.state === "interrupted"
              ? "任务已中断。"
              : conversationKind === "group"
                ? "任务执行失败。完整错误已保存到 FinalBot Web 和 Owner 私聊。"
                : `任务失败：${result.error ?? "未提供错误信息"}`;
        await this.reply(replyAddress, message);
        if (conversationKind === "group" && result.state === "failed" && conversation) {
          const privateAddress = this.ownerPrivateAddress(conversation);
          if (privateAddress) {
            await this.reply(
              privateAddress,
              `任务失败：${result.error ?? "未提供错误信息"}\nRun：${run.id}`,
            );
          }
        }
      }
    } finally {
      this.activeConversations.delete(conversationId);
      if (!this.closed && this.db.getPendingInbox(conversationId).length > 0) {
        this.scheduleConversation(conversationId);
      }
    }
  }

  async createWebRun(prompt: string, botId = "coder"): Promise<RunRecord> {
    const bot = this.db.getBotProfile(botId);
    if (!bot?.enabled) {
      throw new Error(`Bot 不存在或未启用：${botId}`);
    }
    if (bot.workspaceMode === "git-worktree" && !this.workspace) {
      throw new Error("FINALBOT_REPO_PATH is not configured for git-worktree mode");
    }
    const conversation = this.db.upsertConversation({
      channel: "web",
      accountId: "local",
      externalId: "main",
      conversationKind: "private",
      title: "FinalBot Web",
      metadata: {
        replyAddress: { channelId: "web", accountId: "local", data: {} },
      },
    });
    const message = this.db.insertMessage({
      conversationId: conversation.id,
      channelId: "web",
      accountId: "local",
      externalConversationId: "main",
      role: "user",
      senderId: "web:local",
      text: prompt,
      replyAddress: { channelId: "web", accountId: "local", data: {} },
      metadata: { kind: "web_run_prompt" },
    }).message;
    const run = this.db.createRun({
      conversationId: conversation.id,
      prompt,
      requestedBy: "web:local",
      botId: bot.id,
      botName: bot.name,
      botInstructions: bot.instructions,
      agent: bot.agent,
      model: bot.model ?? this.config.codex.model,
      replyAddress: { channelId: "web", accountId: "local", data: {} },
      trigger: "web",
      workspaceMode: bot.workspaceMode,
    });
    this.db.linkRunMessages(run.id, [message.id]);
    const sessionRun = this.inheritConversationSession(run, prompt);
    this.publishRun(sessionRun);
    void this.executeRun(sessionRun).catch(() => undefined);
    return sessionRun;
  }

  private inheritConversationSession(run: RunRecord, prompt: string): RunRecord {
    const session = this.db.getLatestConversationSession(run.conversationId, run.botId);
    if (!session?.nativeThreadId) return run;
    const toolHash = this.tools?.current().hash;
    if (!toolHash) {
      return this.db.updateRun(run.id, { nativeThreadId: session.nativeThreadId });
    }
    const sessionRun = this.db
      .listRuns(200)
      .find(
        (candidate) =>
          candidate.conversationId === run.conversationId &&
          candidate.botId === run.botId &&
          candidate.nativeThreadId === session.nativeThreadId,
      );
    if (sessionRun?.toolSnapshotHash === toolHash) {
      return this.db.updateRun(run.id, { nativeThreadId: session.nativeThreadId });
    }
    return this.db.updateRun(run.id, {
      prompt: `${prompt}\n\n[Tool snapshot changed; continuing in a fresh Codex thread]`,
    });
  }

  private async executeSubagentRun(runId: string): Promise<RunRecord> {
    const run = this.db.getRun(runId);
    if (!run) throw new Error(`Sub Agent run not found: ${runId}`);
    if (run.trigger !== "subagent" || !run.parentRunId) {
      throw new Error(`Run ${runId} is not a Sub Agent run`);
    }
    const parent = this.db.getRun(run.parentRunId);
    if (!parent) throw new Error(`Sub Agent parent not found: ${run.parentRunId}`);
    if (!parent.workspacePath) {
      throw new Error(`Sub Agent parent has no prepared workspace: ${parent.id}`);
    }
    return this.executeRun(run, { workspacePath: parent.workspacePath });
  }

  private async executeCrossBotRun(runId: string): Promise<RunRecord> {
    const run = this.db.getRun(runId);
    if (!run) throw new Error(`Cross-Bot run not found: ${runId}`);
    if (run.trigger !== "agent-message") {
      throw new Error(`Run ${runId} is not a Cross-Bot run`);
    }
    return this.executeRun(run);
  }

  private async executeRun(
    run: RunRecord,
    options: { workspacePath?: string } = {},
  ): Promise<RunRecord> {
    if (this.interruptRequested.has(run.id)) {
      return this.endBeforeStart(run.id);
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
      const workspacePath = options.workspacePath ?? (await this.prepareWorkspace(run));
      current = this.db.updateRun(run.id, { workspacePath });
      this.db.putPhase({
        runId: run.id,
        phase: "workspace",
        status: "done",
        checkpoint: { path: workspacePath, mode: run.workspaceMode },
      });
      if (this.interruptRequested.has(run.id)) {
        return this.endBeforeStart(run.id);
      }
      const toolSnapshot = this.tools?.current() ?? null;
      if (toolSnapshot) {
        const previous = this.db.getLatestConversationSession(run.conversationId, run.botId);
        const snapshotChanged =
          Boolean(current.nativeThreadId) &&
          Boolean(run.toolSnapshotHash) &&
          run.toolSnapshotHash !== toolSnapshot.hash;
        if (snapshotChanged && previous) {
          const recent = this.db.listRunMessages(run.id);
          const summary = recent
            .slice(-8)
            .map((message) => `${message.role}: ${message.text}`)
            .join("\n");
          current = this.db.updateRun(run.id, {
            nativeThreadId: null,
            prompt: summary
              ? `${current.prompt}\n\n[Tool snapshot changed. Continue from this handoff context]\n${summary}`
              : current.prompt,
          });
        }
        current = this.db.updateRun(run.id, {
          toolRevision: toolSnapshot.revision,
          toolSnapshotHash: toolSnapshot.hash,
          toolSnapshotJson: JSON.stringify(
            toolSnapshot.tools.map((tool) => ({
              namespace: tool.namespace,
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
              policy: tool.policy,
            })),
          ),
        });
      }
      this.db.putPhase({
        runId: run.id,
        phase: "agent.start",
        status: "running",
        checkpoint: { cwd: workspacePath },
      });

      const handle = this.agent.start(
        {
          runId: run.id,
          prompt: current.prompt,
          cwd: workspacePath,
          conversationId: run.conversationId,
          botId: run.botId,
          ownerId: this.db.getOwner()?.id ?? null,
          ...(current.nativeThreadId ? { nativeThreadId: current.nativeThreadId } : {}),
          ...(run.model ? { model: run.model } : {}),
          ...(run.botInstructions ? { developerInstructions: run.botInstructions } : {}),
          sandbox: this.config.codex.sandbox,
          ...(toolSnapshot ? { dynamicTools: this.tools?.specs(toolSnapshot) ?? [] } : {}),
        },
        {
          event: async (event) => this.handleAgentEvent(run.id, event),
          requestApproval: async (request) => this.requestApproval(run.id, request),
          callTool: async (call) => this.callTool(run.id, call),
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
      if (result.output.trim()) {
        const outputMessage = this.db.insertMessage({
          conversationId: run.conversationId,
          channelId: run.replyAddress?.channelId ?? "system",
          accountId: run.replyAddress?.accountId ?? "system",
          role: "assistant",
          text: result.output,
          metadata: { kind: "run_output", runId: run.id, botId: run.botId },
        });
        this.db.linkRunMessages(run.id, [outputMessage.message.id]);
      }
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

  private async callTool(runId: string, call: DynamicToolCall): Promise<DynamicToolResult> {
    const run = this.db.getRun(runId);
    if (!run) {
      return {
        success: false,
        contentItems: [{ type: "inputText", text: JSON.stringify({ error: "Run not found" }) }],
      };
    }
    if (!this.tools) {
      return {
        success: false,
        contentItems: [
          { type: "inputText", text: JSON.stringify({ error: "Tool registry unavailable" }) },
        ],
      };
    }
    return this.tools.call(
      {
        namespace: call.namespace ?? null,
        tool: call.tool,
        arguments: call.arguments,
      },
      {
        runId,
        conversationId: run.conversationId,
        botId: run.botId,
        ownerId: this.db.getOwner()?.id ?? null,
        ...(run.toolSnapshotHash ? { toolSnapshotHash: run.toolSnapshotHash } : {}),
        requestApproval: async (request: Omit<PendingApproval, "runId">) =>
          this.requestApproval(runId, request),
      },
    );
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
    if (run.replyAddress) {
      const conversation = this.db.getConversation(run.conversationId);
      await this.reply(
        run.replyAddress,
        conversation?.conversationKind === "group"
          ? formatPublicApprovalNotice(record)
          : formatApprovalNotice(record),
      );
      if (conversation?.conversationKind === "group") {
        const privateAddress = this.ownerPrivateAddress(conversation);
        if (privateAddress) {
          await this.reply(privateAddress, formatApprovalNotice(record));
        }
      }
    }
    const decision = await decisionPromise;
    const resolved = this.db.resolveApproval(requestId, decision);
    if (decision.action !== "cancel") {
      this.publishApproval(resolved, "approval.resolved");
    }
    const resolvedConversation = this.db.getConversation(run.conversationId);
    if (
      run.replyAddress &&
      decision.action !== "cancel" &&
      resolvedConversation?.conversationKind !== "group"
    ) {
      await this.reply(run.replyAddress, `审批已处理：${record.title} -> ${decision.action}`);
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
    const orchestration = this.db.recoverOrchestrationAfterRestart();
    for (const run of recoveredRuns) this.publishRun(run);
    if (
      recoveredRuns.length > 0 ||
      inbox.failed > 0 ||
      orchestration.subagentTasks > 0 ||
      orchestration.agentMessages > 0
    ) {
      this.emitEvent(null, {
        type: "system",
        level: "warning",
        message: `Recovered after restart: ${recoveredRuns.length} run(s) interrupted, ${inbox.failed} message(s) marked failed, ${orchestration.subagentTasks} Sub Agent task(s) failed, ${orchestration.agentMessages} Cross-Bot dispatch(es) failed, ${inbox.queues.length} conversation/bot queue(s) requeued.`,
        at: nowIso(),
      });
    }
    for (const conversationId of new Set(inbox.queues.map((queue) => queue.conversationId))) {
      this.scheduleConversation(conversationId);
    }
    this.db.recoverOutboxAfterRestart();
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

function formatPublicApprovalNotice(approval: ApprovalRecord): string {
  return [
    "需要 Owner 审批",
    `事项：${approval.title}`,
    `审批 ID：${approval.requestId}`,
    "已发送到 Owner 私聊。",
  ].join("\n");
}

function truncate(value: string, max: number): string {
  const compact = value.trim();
  return compact.length > max ? `${compact.slice(0, max)}...` : compact;
}

function parseReplyPayload(
  payload: unknown,
): { address: OutboundAddress; text: string; format?: "text" | "markdown" } | null {
  if (!payload || typeof payload !== "object") return null;
  const candidate = payload as {
    address?: unknown;
    target?: unknown;
    text?: unknown;
    format?: unknown;
  };
  if (typeof candidate.text !== "string") return null;
  if (isOutboundAddress(candidate.address)) {
    return {
      address: candidate.address,
      text: candidate.text,
      ...(candidate.format === "markdown" ? { format: "markdown" as const } : {}),
    };
  }
  // Accept pre-migration outbox rows without keeping platform types in core.
  if (!candidate.target || typeof candidate.target !== "object") return null;
  const target = candidate.target as Record<string, unknown>;
  if (target.kind === "web") {
    return {
      address: { channelId: "web", accountId: "local", data: {} },
      text: candidate.text,
    };
  }
  if (
    target.kind === "onebot" &&
    (target.messageType === "group" || target.messageType === "private")
  ) {
    return {
      address: {
        channelId: "onebot",
        accountId: String(target.selfId ?? target.accountId ?? "unknown"),
        data:
          target.messageType === "group"
            ? { messageType: "group", groupId: String(target.groupId ?? "") }
            : { messageType: "private", userId: String(target.userId ?? "") },
      },
      text: candidate.text,
    };
  }
  return null;
}

function isRetryableDeliveryError(message: string): boolean {
  const detail = message.toLocaleLowerCase();
  if (detail.includes("passive") || detail.includes("msg_id")) return false;
  if (detail.includes("unsupported") || detail.includes("invalid address")) return false;
  if (detail.includes("unknown channel")) return false;
  return true;
}

function isOutboundAddress(value: unknown): value is OutboundAddress {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<OutboundAddress>;
  return (
    typeof candidate.channelId === "string" &&
    typeof candidate.accountId === "string" &&
    !!candidate.data &&
    typeof candidate.data === "object"
  );
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
