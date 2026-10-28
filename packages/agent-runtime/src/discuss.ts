import type { AgentAdapter, DiscussDecision } from "@finalbot/core";
import { createId, nowIso } from "@finalbot/core";
import type { DiscussBatchRecord, FinalBotDatabase } from "@finalbot/db";
import type { MemoryService } from "./memory";

const DECISION_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["send", "silent"] },
    reason: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["action", "reason", "confidence"],
  additionalProperties: false,
};

export interface DiscussServiceOptions {
  db: FinalBotDatabase;
  agent: AgentAdapter & { close?: () => Promise<void> };
  memory: MemoryService;
  debounceMs?: number;
  maxWaitMs?: number;
}

type DiscussSendHandler = (
  batch: DiscussBatchRecord,
  messageIds: string[],
) => Promise<string | null>;

export class DiscussService {
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly processing = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: DiscussServiceOptions) {
    this.debounceMs = options.debounceMs ?? 3_000;
    this.maxWaitMs = options.maxWaitMs ?? 15_000;
  }

  enqueue(input: { conversationId: string; botId: string; messageId: string }): DiscussBatchRecord {
    return this.options.db.openDiscussBatch({
      conversationId: input.conversationId,
      botId: input.botId,
      messageId: input.messageId,
      debounceMs: this.debounceMs,
      maxWaitMs: this.maxWaitMs,
    });
  }

  noteExplicitCall(conversationId: string, botId: string): void {
    // An explicit call supersedes pending ambient discussion for the same
    // conversation/bot pair; the explicit message will create its own run.
    this.options.db.closeOpenDiscussBatch(conversationId, botId, "superseded_by_explicit_call");
  }

  start(onSend: DiscussSendHandler): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(onSend), 500);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async recover(onSend: DiscussSendHandler) {
    this.options.db.recoverDiscussBatches();
    await this.tick(onSend);
  }

  async tick(onSend: DiscussSendHandler): Promise<void> {
    for (const batch of this.options.db.listDueDiscussBatches()) {
      if (this.processing.has(batch.id)) continue;
      this.processing.add(batch.id);
      try {
        const decision = await this.evaluate(batch);
        const messageIds = this.options.db
          .listDiscussBatchMessages(batch.id)
          .map((message) => message.id);
        let runId: string | null = null;
        if (decision.action === "send") {
          runId = await onSend(batch, messageIds);
        }
        const dispatched = decision.action === "send" && Boolean(runId);
        this.options.db.finishDiscussBatch({
          batchId: batch.id,
          action: dispatched ? "send" : "silent",
          reason:
            decision.action === "send" && !runId
              ? "discuss_dispatch_returned_no_run"
              : decision.reason,
          confidence: decision.action === "send" && !runId ? 0 : decision.confidence,
          messageIds,
          model: this.options.db.getBotProfile(batch.botId)?.model ?? null,
          runId,
        });
      } catch (error) {
        const messageIds = this.options.db
          .listDiscussBatchMessages(batch.id)
          .map((item) => item.id);
        this.options.db.finishDiscussBatch({
          batchId: batch.id,
          action: "silent",
          reason: `discuss_failed: ${error instanceof Error ? error.message : String(error)}`,
          confidence: 0,
          messageIds,
        });
      } finally {
        this.processing.delete(batch.id);
      }
    }
  }

  private async evaluate(batch: DiscussBatchRecord): Promise<DiscussDecision> {
    const messages = this.options.db
      .listDiscussBatchMessages(batch.id)
      .filter((message) => message.role === "user");
    if (messages.length === 0) {
      return { action: "silent", reason: "No user messages in batch", confidence: 1 };
    }
    const bot = this.options.db.getBotProfile(batch.botId);
    if (!bot?.enabled) {
      return { action: "silent", reason: "Bot is disabled", confidence: 1 };
    }
    const history = this.options.db.listMessages(batch.conversationId, 20);
    const memory = this.options.memory.search("", {
      runId: createId("discuss"),
      conversationId: batch.conversationId,
      botId: batch.botId,
      ownerId: null,
    });
    const prompt = [
      "Decide whether this bot should speak in the group conversation.",
      "Return send only when a reply adds concrete value. Otherwise return silent.",
      `Bot: ${bot.name}`,
      `Instructions: ${bot.instructions}`,
      `Bot memory: ${JSON.stringify(memory.filter((item) => item.scope !== "owner"))}`,
      "Recent conversation:",
      ...history.map(
        (message) =>
          `[${message.createdAt}] ${message.role} ${message.senderId ?? "system"}: ${message.text}`,
      ),
      "Current batch:",
      ...messages.map((message) => `${message.senderId ?? "unknown"}: ${message.text}`),
    ].join("\n");

    const handle = this.options.agent.start(
      {
        runId: createId("discuss"),
        prompt,
        cwd: process.cwd(),
        developerInstructions:
          "You are a group-chat participation gate. Do not perform the requested work; only classify whether speaking is useful.",
        sandbox: "read-only",
        ...(bot.model ? { model: bot.model } : {}),
        outputSchema: DECISION_SCHEMA,
      },
      {
        event: () => undefined,
        requestApproval: async () => ({ action: "decline" }),
      },
    );
    const result = await handle.result;
    if (result.status !== "succeeded") {
      return {
        action: "silent",
        reason: result.error ?? "Decision model failed",
        confidence: 0,
      };
    }
    return parseDecision(result.structuredOutput, result.output);
  }
}

function parseDecision(structuredOutput: unknown, output: string): DiscussDecision {
  const value = structuredOutput ?? parseJson(output);
  if (!value || typeof value !== "object") {
    return { action: "silent", reason: "Invalid structured output", confidence: 0 };
  }
  const record = value as Record<string, unknown>;
  const action = record.action === "send" ? "send" : "silent";
  return {
    action,
    reason: typeof record.reason === "string" ? record.reason : "No reason provided",
    confidence:
      typeof record.confidence === "number" ? Math.max(0, Math.min(1, record.confidence)) : 0,
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function discussMessageMetadata(decision: {
  action: "send" | "silent";
  reason: string;
}): Record<string, unknown> {
  return {
    kind: "discuss_decision",
    action: decision.action,
    reason: decision.reason,
    at: nowIso(),
  };
}
