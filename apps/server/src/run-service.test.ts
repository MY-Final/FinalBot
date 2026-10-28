import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentAdapter,
  AgentRunHandle,
  AgentSink,
  ApprovalDecision,
  InboundMessage,
} from "@finalbot/core";
import { FinalBotDatabase } from "@finalbot/db";
import { loadConfig } from "./config";
import { EventBus } from "./event-bus";
import { RunService } from "./run-service";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(cleanupTempDir));
});

describe("IM approvals and interruption", () => {
  test("requeues pending inbox work after a restart", async () => {
    const env = await setup();
    const conversation = env.db.upsertConversation({
      channel: "onebot",
      accountId: "bot",
      externalId: "private:restart",
      conversationKind: "private",
      metadata: {
        replyTarget: { kind: "onebot", messageType: "private", userId: "restart" },
      },
    });
    env.db.admitInbound({
      conversationId: conversation.id,
      externalMessageId: "restart-message",
      senderId: "restart",
      text: "resume this",
      raw: {},
      receivedAt: new Date().toISOString(),
    });
    const service = new RunService(env.db, new EventBus(), env.config);
    service.setReplySender(async () => undefined);

    try {
      await service.recover();
      const run = await waitFor(() => {
        const current = env.db.listRuns()[0];
        return current?.state === "succeeded" ? current : null;
      });
      expect(run.prompt).toBe("resume this");
      expect(env.db.getPendingInbox(conversation.id)).toHaveLength(0);
    } finally {
      await service.close();
      env.db.close();
    }
  });

  test("keeps a failed reply queued and flushes it after the sender recovers", async () => {
    const env = await setup();
    const service = new RunService(env.db, new EventBus(), env.config, new ApprovalTestAgent());
    let connected = false;
    const delivered: string[] = [];
    service.setReplySender(async (_target, text) => {
      if (!connected) throw new Error("offline");
      delivered.push(text);
    });

    try {
      await service.admitInbound(message("outbox-1", "make a change"));
      const approval = await waitFor(() => pending(env.db));
      await waitFor(() => (env.db.pendingOutbox().length > 0 ? true : null));
      expect(env.db.pendingOutbox()[0]?.type).toBe("reply");

      connected = true;
      await service.flushOutbox();
      service.resolveApproval(approval.requestId, { action: "accept" });
      await waitFor(() => {
        const run = env.db.listRuns()[0];
        return run?.state === "succeeded" ? run : null;
      });
      expect(env.db.pendingOutbox()).toHaveLength(0);
      expect(delivered.some((text) => text.includes("需要审批"))).toBe(true);
    } finally {
      await service.close();
      env.db.close();
    }
  });

  test("accepts an approval response published on the approval event", async () => {
    const env = await setup();
    const agent = new ApprovalTestAgent();
    const bus = new EventBus();
    const service = new RunService(env.db, bus, env.config, agent);
    service.setReplySender(async () => undefined);
    bus.subscribe(({ event }) => {
      if (event.type === "approval.requested") {
        service.resolveApproval(event.approval.requestId, { action: "accept" });
      }
    });

    try {
      await service.admitInbound(message("prompt-live", "make a change"));
      const run = await waitFor(() => {
        const current = env.db.listRuns()[0];
        return current?.state === "succeeded" ? current : null;
      });
      expect(run.state).toBe("succeeded");
      expect(agent.decisions).toEqual([{ action: "accept" }]);
    } finally {
      await service.close();
      env.db.close();
    }
  });

  test("approves a pending action without creating an inbox run for the command", async () => {
    const env = await setup();
    const agent = new ApprovalTestAgent();
    const service = new RunService(env.db, new EventBus(), env.config, agent);
    const replies: string[] = [];
    service.setReplySender(async (_target, text) => {
      replies.push(text);
    });

    try {
      await service.admitInbound(message("prompt-1", "make a change"));
      const approval = await waitFor(() => pending(env.db));
      expect(approval.requestId.startsWith("approval_")).toBe(true);
      expect(approval.requestId).not.toBe("1");
      expect(replies.some((text) => text.includes("需要审批"))).toBe(true);

      await service.admitInbound(message("command-1", "/approve"));
      const run = await waitFor(() => {
        const current = env.db.listRuns()[0];
        return current?.state === "succeeded" ? current : null;
      });
      expect(run.state).toBe("succeeded");
      expect(agent.decisions).toEqual([{ action: "accept" }]);
      expect(env.db.getApproval(approval.requestId)?.status).toBe("accepted");
      expect(env.db.getPendingInbox(run.conversationId)).toHaveLength(0);
      expect(env.db.db.query("SELECT text FROM inbox_items ORDER BY created_at").all()).toEqual([
        { text: "make a change" },
      ]);
    } finally {
      await service.close();
      env.db.close();
    }
  });

  test("cancelling a run releases its pending approval and interrupts the agent", async () => {
    const env = await setup();
    const agent = new ApprovalTestAgent();
    const service = new RunService(env.db, new EventBus(), env.config, agent);
    service.setReplySender(async () => undefined);

    try {
      await service.admitInbound(message("prompt-2", "make a change"));
      const approval = await waitFor(() => pending(env.db));

      await service.admitInbound(message("command-2", "/cancel"));
      const run = await waitFor(() => {
        const current = env.db.listRuns()[0];
        return current?.state === "interrupted" ? current : null;
      });
      expect(run.state).toBe("interrupted");
      expect(env.db.getApproval(approval.requestId)?.status).toBe("cancelled");
      expect(agent.decisions).toEqual([{ action: "cancel" }]);
      expect(agent.interrupted).toBe(true);
    } finally {
      await service.close();
      env.db.close();
    }
  });

  test("a cancel that arrives before agent start prevents workspace execution leakage", async () => {
    const env = await setup();
    const agent = new ApprovalTestAgent();
    const service = new RunService(env.db, new EventBus(), env.config, agent);
    service.setReplySender(async () => undefined);

    try {
      await service.admitInbound(message("prompt-3", "make a change"));
      const run = await waitFor(() => env.db.listRuns()[0] ?? null);
      await service.interrupt(run.id);
      const stopped = await waitFor(() => {
        const current = env.db.getRun(run.id);
        return current && current.state !== "admitted" && current.state !== "running"
          ? current
          : null;
      });
      expect(["cancelled", "interrupted"]).toContain(stopped.state);
      expect(stopped.finishedAt).not.toBeNull();
      expect(agent.started).toBe(false);
      await waitFor(() =>
        env.db
          .listPhases(run.id)
          .some((phase) => phase.phase === "agent" && phase.status === "interrupted")
          ? true
          : null,
      );
    } finally {
      await service.close();
      env.db.close();
    }
  });
});

describe("bot dispatch", () => {
  test("lists bots and switches the active bot without creating a run", async () => {
    const env = await setup();
    env.db.upsertBotProfile({
      id: "reviewer",
      name: "Reviewer",
      description: "Reviews changes",
      instructions: "Review code carefully.",
      agent: "codex",
      model: "review-model",
    });
    const service = new RunService(env.db, new EventBus(), env.config);
    const replies: string[] = [];
    service.setReplySender(async (_target, text) => {
      replies.push(text);
    });

    try {
      await service.admitInbound(message("bots-1", "/bots"));
      expect(replies.at(-1)).toContain("coder / Coder / codex");
      expect(replies.at(-1)).toContain("reviewer / Reviewer / codex");
      expect(replies.at(-1)).toContain("当前：coder");
      expect(env.db.listRuns()).toHaveLength(0);

      await service.admitInbound(message("use-1", "/use reviewer"));
      const conversation = env.db.getConversationByExternal("onebot", "bot", "private:10001");
      expect(conversation?.activeBotId).toBe("reviewer");
      expect(replies.at(-1)).toContain("Reviewer");
      expect(env.db.listRuns()).toHaveLength(0);
    } finally {
      await service.close();
      env.db.close();
    }
  });

  test("dispatches a one-shot bot without changing the active bot", async () => {
    const env = await setup();
    env.db.upsertBotProfile({
      id: "reviewer",
      name: "Reviewer",
      description: "Reviews changes",
      instructions: "Review code carefully.",
      agent: "codex",
      model: "review-model",
    });
    const service = new RunService(env.db, new EventBus(), env.config, new InspectingAgent());
    service.setReplySender(async () => undefined);

    try {
      await service.admitInbound(message("bot-1", "/bot reviewer inspect the auth flow"));
      const run = await waitFor(() => {
        const current = env.db.listRuns()[0];
        return current?.state === "succeeded" ? current : null;
      });
      expect(run).toMatchObject({
        botId: "reviewer",
        botName: "Reviewer",
        botInstructions: "Review code carefully.",
        model: "review-model",
        prompt: "inspect the auth flow",
      });
      const conversation = env.db.getConversationByExternal("onebot", "bot", "private:10001");
      expect(conversation?.activeBotId).toBe("coder");
    } finally {
      await service.close();
      env.db.close();
    }
  });

  test("freezes bot ownership for queued messages before a later /use", async () => {
    const env = await setup();
    env.db.upsertBotProfile({
      id: "reviewer",
      name: "Reviewer",
      description: "Reviews changes",
      instructions: "Review code carefully.",
      agent: "codex",
    });
    const service = new RunService(env.db, new EventBus(), env.config, new InspectingAgent());
    service.setReplySender(async () => undefined);

    try {
      await service.admitInbound(message("queued-1", "coder task"));
      await service.admitInbound(message("use-2", "/use reviewer"));
      const run = await waitFor(() => {
        const current = env.db.listRuns()[0];
        return current?.state === "succeeded" ? current : null;
      });
      expect(run.botId).toBe("coder");
      const conversation = env.db.getConversationByExternal("onebot", "bot", "private:10001");
      expect(conversation?.activeBotId).toBe("reviewer");
    } finally {
      await service.close();
      env.db.close();
    }
  });

  test("uses the active bot profile for later normal messages", async () => {
    const env = await setup();
    env.db.upsertBotProfile({
      id: "reviewer",
      name: "Reviewer",
      description: "Reviews changes",
      instructions: "Review code carefully.",
      agent: "codex",
    });
    const agent = new InspectingAgent();
    const service = new RunService(env.db, new EventBus(), env.config, agent);
    service.setReplySender(async () => undefined);

    try {
      await service.admitInbound(message("use-3", "/use reviewer"));
      await service.admitInbound(message("queued-2", "review this change"));
      const run = await waitFor(() => {
        const current = env.db.listRuns()[0];
        return current?.state === "succeeded" ? current : null;
      });
      expect(run).toMatchObject({
        botId: "reviewer",
        botName: "Reviewer",
        botInstructions: "Review code carefully.",
        prompt: "review this change",
      });
      expect(agent.inputs[0]).toMatchObject({
        developerInstructions: "Review code carefully.",
        prompt: "review this change",
      });
    } finally {
      await service.close();
      env.db.close();
    }
  });

  test("does not merge pending messages from different bots into one run", async () => {
    const env = await setup();
    env.db.upsertBotProfile({
      id: "reviewer",
      name: "Reviewer",
      description: "Reviews changes",
      instructions: "Review code carefully.",
      agent: "codex",
    });
    const agent = new InspectingAgent({ pauseMs: 150 });
    const service = new RunService(env.db, new EventBus(), env.config, agent);
    service.setReplySender(async () => undefined);

    try {
      await service.admitInbound(message("mixed-1", "coder task"));
      await service.admitInbound(message("mixed-2", "/bot reviewer review task"));
      await waitFor(() => (env.db.listRuns().length === 2 ? true : null));
      await waitFor(() =>
        env.db.listRuns().every((run) => run.state === "succeeded") ? true : null,
      );

      const runs = env.db.listRuns().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      expect(runs.map((run) => run.botId)).toEqual(["coder", "reviewer"]);
      expect(runs.map((run) => run.prompt)).toEqual(["coder task", "review task"]);
    } finally {
      await service.close();
      env.db.close();
    }
  });
});

class ApprovalTestAgent implements AgentAdapter {
  readonly decisions: ApprovalDecision[] = [];
  interrupted = false;
  started = false;

  start(input: Parameters<AgentAdapter["start"]>[0], sink: AgentSink): AgentRunHandle {
    this.started = true;
    let resolve!: (value: Awaited<AgentRunHandle["result"]>) => void;
    const result = new Promise<Awaited<AgentRunHandle["result"]>>((done) => {
      resolve = done;
    });
    void (async () => {
      await sink.event({ type: "thread", nativeThreadId: "thread_test" });
      await sink.event({ type: "turn", nativeTurnId: `turn_${input.runId}` });
      const decision = await sink.requestApproval({
        requestId: "1",
        kind: "command",
        title: "Approve command",
        detail: "git status",
        canAcceptForSession: true,
        payload: {},
      });
      this.decisions.push(decision);
      resolve({
        status: decision.action === "cancel" || this.interrupted ? "interrupted" : "succeeded",
        nativeThreadId: "thread_test",
        nativeTurnId: `turn_${input.runId}`,
        output: "done",
      });
    })();
    return {
      result,
      interrupt: async () => {
        this.interrupted = true;
      },
    };
  }
}

class InspectingAgent implements AgentAdapter {
  readonly inputs: Parameters<AgentAdapter["start"]>[0][] = [];

  constructor(private readonly options: { pauseMs?: number } = {}) {}

  start(input: Parameters<AgentAdapter["start"]>[0], sink: AgentSink): AgentRunHandle {
    this.inputs.push(input);
    const result = (async () => {
      await sink.event({ type: "thread", nativeThreadId: `thread_${input.runId}` });
      await sink.event({ type: "turn", nativeTurnId: `turn_${input.runId}` });
      if (this.options.pauseMs) await Bun.sleep(this.options.pauseMs);
      return {
        status: "succeeded" as const,
        nativeThreadId: `thread_${input.runId}`,
        nativeTurnId: `turn_${input.runId}`,
        output: "done",
      };
    })();
    return {
      result,
      interrupt: async () => undefined,
    };
  }
}

async function setup(): Promise<{
  db: FinalBotDatabase;
  config: ReturnType<typeof loadConfig>;
}> {
  const root = await mkdtemp(join(tmpdir(), "finalbot-service-"));
  tempDirs.push(root);
  const repo = join(root, "repo");
  const data = join(root, "data");
  await Bun.$`git init ${repo}`.quiet();
  await Bun.$`git -C ${repo} config user.email test@finalbot.local`.quiet();
  await Bun.$`git -C ${repo} config user.name FinalBot`.quiet();
  await writeFile(join(repo, "README.md"), "# test\n");
  await Bun.$`git -C ${repo} add README.md`.quiet();
  await Bun.$`git -C ${repo} commit -m init`.quiet();

  return {
    db: new FinalBotDatabase(join(root, "test.sqlite")),
    config: loadConfig({
      FINALBOT_DATA_DIR: data,
      FINALBOT_REPO_PATH: repo,
      FINALBOT_FAKE_AGENT: "1",
    }),
  };
}

async function cleanupTempDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
      return;
    } catch (error) {
      if (attempt === 7) {
        console.warn(
          `[finalbot-test] leaving temp directory after cleanup failure: ${dir} (${String(error)})`,
        );
        return;
      }
      await Bun.sleep(100);
    }
  }
}

function message(id: string, text: string): InboundMessage {
  return {
    channel: "onebot",
    accountId: "bot",
    externalConversationId: "private:10001",
    conversationKind: "private",
    externalMessageId: id,
    senderId: "10001",
    text,
    raw: {},
    receivedAt: new Date().toISOString(),
    replyTarget: { kind: "onebot", messageType: "private", userId: "10001" },
  };
}

function pending(db: FinalBotDatabase) {
  const run = db.listRuns()[0];
  if (!run) return null;
  return db.listPendingApprovals(run.id)[0] ?? null;
}

async function waitFor<T>(read: () => T | null, timeoutMs = 5000): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = read();
    if (value) return value;
    await Bun.sleep(20);
  }
  throw new Error("Timed out waiting for condition");
}
