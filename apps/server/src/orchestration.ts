import { createHash } from "node:crypto";
import { nowIso } from "@finalbot/core";
import type {
  AgentMessageRecord,
  FinalBotDatabase,
  RunRecord,
  SubagentTaskRecord,
} from "@finalbot/db";

export interface OrchestrationLimits {
  maxConcurrentSubagents: number;
  maxSubagentsPerParent: number;
  subagentTimeoutMs: number;
  maxCrossBotHops: number;
  maxCrossBotDispatchesPerParent: number;
  crossBotTimeoutMs: number;
  maxSummaryCharacters: number;
}

export const DEFAULT_ORCHESTRATION_LIMITS: OrchestrationLimits = {
  maxConcurrentSubagents: 3,
  maxSubagentsPerParent: 8,
  subagentTimeoutMs: 10 * 60_000,
  maxCrossBotHops: 3,
  maxCrossBotDispatchesPerParent: 5,
  crossBotTimeoutMs: 10 * 60_000,
  maxSummaryCharacters: 16 * 1024,
};

export interface OrchestrationRunner {
  executeSubagent(runId: string): Promise<RunRecord>;
  executeCrossBot(runId: string): Promise<RunRecord>;
  interrupt(runId: string): Promise<void>;
}

export interface OrchestrationResult {
  kind: "subagent" | "cross-bot";
  id: string;
  status: "succeeded" | "failed" | "timed_out" | "cancelled";
  runId: string | null;
  summary: unknown;
  error: string | null;
}

export class OrchestrationService {
  private readonly limits: OrchestrationLimits;

  constructor(
    private readonly db: FinalBotDatabase,
    private readonly runner: OrchestrationRunner,
    limits: Partial<OrchestrationLimits> = {},
  ) {
    this.limits = { ...DEFAULT_ORCHESTRATION_LIMITS, ...limits };
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Invalid orchestration limit ${name}: ${value}`);
      }
    }
  }

  async spawnSubagent(input: {
    parentRunId: string;
    prompt: string;
  }): Promise<OrchestrationResult> {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("Sub Agent prompt cannot be empty");
    const parent = this.requireRunningRun(input.parentRunId, "parent");
    if (parent.trigger === "subagent") {
      throw new Error("Sub Agents cannot spawn nested Sub Agents");
    }
    if (!parent.workspacePath) {
      throw new Error("Parent run has no prepared workspace for a Sub Agent");
    }
    const bot = this.db.getBotProfile(parent.botId);
    if (!bot?.enabled) {
      throw new Error(`Parent Bot is unavailable: ${parent.botId}`);
    }

    const task = this.db.createSubagentTask({
      parentRunId: parent.id,
      botId: parent.botId,
      prompt,
      deadlineAt: new Date(Date.now() + this.limits.subagentTimeoutMs).toISOString(),
      maxConcurrent: this.limits.maxConcurrentSubagents,
      maxTotal: this.limits.maxSubagentsPerParent,
    });

    let child: RunRecord;
    try {
      child = this.db.createRun({
        conversationId: parent.conversationId,
        prompt,
        requestedBy: parent.requestedBy,
        botId: parent.botId,
        botName: parent.botName,
        botInstructions: subagentInstructions(parent.botInstructions ?? bot.instructions),
        agent: parent.agent,
        model: parent.model,
        trigger: "subagent",
        parentRunId: parent.id,
        workspaceMode: parent.workspaceMode,
      });
    } catch (error) {
      const detail = errorMessage(error);
      this.db.updateSubagentTask(task.id, {
        status: "failed",
        error: detail,
        finishedAt: nowIso(),
      });
      throw error;
    }

    this.db.updateSubagentTask(task.id, {
      childRunId: child.id,
      status: "running",
      startedAt: nowIso(),
    });

    const outcome = await runWithTimeout(
      this.runner.executeSubagent(child.id),
      this.limits.subagentTimeoutMs,
      async () => {
        await this.runner.interrupt(child.id);
      },
    );
    const result = this.toSubagentResult(task, child.id, outcome);
    this.db.updateSubagentTask(task.id, {
      status: result.status,
      result,
      error: result.error,
      finishedAt: nowIso(),
    });
    return result;
  }

  async dispatchToBot(input: {
    sourceRunId: string;
    targetBotId: string;
    prompt: string;
  }): Promise<OrchestrationResult> {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("Cross-Bot prompt cannot be empty");
    const source = this.requireRunningRun(input.sourceRunId, "source");
    if (source.trigger === "subagent") {
      throw new Error("Sub Agents cannot dispatch messages to other Bots");
    }
    const targetBotId = input.targetBotId.trim().toLowerCase();
    if (!targetBotId) throw new Error("Target Bot id cannot be empty");
    const targetBot = this.db.getBotProfile(targetBotId);
    if (!targetBot?.enabled) {
      throw new Error(`Target Bot is unavailable: ${targetBotId}`);
    }

    const lineage = this.lineageFor(source);
    if (lineage.some((run) => run.botId === targetBotId)) {
      throw new Error(
        `Cross-Bot cycle detected: ${lineage.map((run) => run.botId).join(" -> ")} -> ${targetBotId}`,
      );
    }
    const hopCount = lineage.filter((run) => run.trigger === "agent-message").length + 1;
    if (hopCount > this.limits.maxCrossBotHops) {
      throw new Error(`Cross-Bot hop limit reached (${this.limits.maxCrossBotHops})`);
    }
    const root = lineage[0] ?? source;
    const dedupeKey = crossBotDedupeKey(root.id, source.id, targetBotId, prompt);
    const message = this.db.createAgentMessage({
      sourceRunId: source.id,
      rootRunId: root.id,
      sourceBotId: source.botId,
      targetBotId,
      prompt,
      hopCount,
      dedupeKey,
      maxHops: this.limits.maxCrossBotHops,
      maxPerParent: this.limits.maxCrossBotDispatchesPerParent,
    });

    let targetRun: RunRecord;
    try {
      targetRun = this.db.createRun({
        conversationId: source.conversationId,
        prompt,
        requestedBy: source.requestedBy,
        botId: targetBot.id,
        botName: targetBot.name,
        botInstructions: targetBot.instructions,
        agent: targetBot.agent,
        model: targetBot.model,
        trigger: "agent-message",
        parentRunId: source.id,
        workspaceMode: targetBot.workspaceMode,
      });
    } catch (error) {
      const detail = errorMessage(error);
      this.db.updateAgentMessage(message.id, {
        status: "failed",
        error: detail,
        finishedAt: nowIso(),
      });
      throw error;
    }
    this.db.updateAgentMessage(message.id, {
      targetRunId: targetRun.id,
      status: "running",
      startedAt: nowIso(),
    });

    const outcome = await runWithTimeout(
      this.runner.executeCrossBot(targetRun.id),
      this.limits.crossBotTimeoutMs,
      async () => {
        await this.runner.interrupt(targetRun.id);
      },
    );
    const result = this.toCrossBotResult(message, targetRun.id, outcome);
    this.db.updateAgentMessage(message.id, {
      status: result.status === "succeeded" ? "succeeded" : "failed",
      result,
      error: result.error,
      finishedAt: nowIso(),
    });
    return result;
  }

  private requireRunningRun(runId: string, label: string): RunRecord {
    const run = this.db.getRun(runId);
    if (!run) throw new Error(`${label} run not found: ${runId}`);
    if (run.state !== "running") {
      throw new Error(`${label} run must be running to orchestrate work`);
    }
    return run;
  }

  private lineageFor(source: RunRecord): RunRecord[] {
    const lineage: RunRecord[] = [source];
    const visited = new Set([source.id]);
    let current = source;
    while (current.parentRunId) {
      if (visited.has(current.parentRunId)) {
        throw new Error("Run parent cycle detected");
      }
      const parent = this.db.getRun(current.parentRunId);
      if (!parent) throw new Error(`Run parent not found: ${current.parentRunId}`);
      visited.add(parent.id);
      lineage.unshift(parent);
      current = parent;
    }
    return lineage;
  }

  private toSubagentResult(
    task: SubagentTaskRecord,
    childRunId: string,
    outcome: RunOutcome,
  ): OrchestrationResult {
    if (outcome.kind !== "completed") {
      return {
        kind: "subagent",
        id: task.id,
        status: outcome.kind,
        runId: childRunId,
        summary: null,
        error:
          outcome.kind === "timed_out"
            ? `Sub Agent exceeded ${this.limits.subagentTimeoutMs}ms`
            : errorMessage(outcome.error),
      };
    }
    const run = outcome.value;
    const status = orchestrationStatus(run);
    return {
      kind: "subagent",
      id: task.id,
      status,
      runId: run.id,
      summary: summarizeOutput(run.output, this.limits.maxSummaryCharacters),
      error: status === "succeeded" ? null : (run.error ?? `Sub Agent ended in state ${run.state}`),
    };
  }

  private toCrossBotResult(
    message: AgentMessageRecord,
    targetRunId: string,
    outcome: RunOutcome,
  ): OrchestrationResult {
    if (outcome.kind !== "completed") {
      return {
        kind: "cross-bot",
        id: message.id,
        status: outcome.kind,
        runId: targetRunId,
        summary: null,
        error:
          outcome.kind === "timed_out"
            ? `Cross-Bot dispatch exceeded ${this.limits.crossBotTimeoutMs}ms`
            : errorMessage(outcome.error),
      };
    }
    const run = outcome.value;
    const status = orchestrationStatus(run);
    return {
      kind: "cross-bot",
      id: message.id,
      status,
      runId: run.id,
      summary: summarizeOutput(run.output, this.limits.maxSummaryCharacters),
      error:
        status === "succeeded" ? null : (run.error ?? `Cross-Bot run ended in state ${run.state}`),
    };
  }
}

type RunOutcome =
  | { kind: "completed"; value: RunRecord }
  | { kind: "failed"; error: unknown }
  | { kind: "timed_out" };

async function runWithTimeout(
  execution: Promise<RunRecord>,
  timeoutMs: number,
  onTimeout: () => Promise<void>,
): Promise<RunOutcome> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race<RunOutcome>([
      execution.then(
        (value) => ({ kind: "completed", value }),
        (error) => ({ kind: "failed", error }),
      ),
      new Promise<RunOutcome>((resolve) => {
        timer = setTimeout(() => {
          void onTimeout().catch((error) => {
            console.error(
              `[finalbot] failed to interrupt timed-out orchestration: ${errorMessage(error)}`,
            );
          });
          resolve({ kind: "timed_out" });
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function subagentInstructions(base: string): string {
  return [
    base,
    "",
    "You are a Sub Agent working on an isolated task in the same workspace as your parent.",
    "Work independently, do not spawn another Sub Agent, do not dispatch to another Bot, and return a concise structured summary.",
  ].join("\n");
}

function orchestrationStatus(run: RunRecord): "succeeded" | "failed" | "cancelled" {
  if (run.state === "succeeded") return "succeeded";
  if (run.state === "cancelled" || run.state === "interrupted") return "cancelled";
  return "failed";
}

function summarizeOutput(output: string, maxCharacters: number): unknown {
  const trimmed = output.trim();
  if (!trimmed) return { summary: "" };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // A plain-text answer is still returned as a structured summary object.
  }
  return {
    summary:
      trimmed.length > maxCharacters
        ? `${trimmed.slice(0, maxCharacters)}\n[summary truncated]`
        : trimmed,
  };
}

function crossBotDedupeKey(
  rootRunId: string,
  sourceRunId: string,
  targetBotId: string,
  prompt: string,
): string {
  const normalized = prompt.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
  return createHash("sha256")
    .update(`${rootRunId}\0${sourceRunId}\0${targetBotId}\0${normalized}`)
    .digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
