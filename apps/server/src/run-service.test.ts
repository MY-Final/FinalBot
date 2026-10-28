import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentAdapter,
  AgentRunHandle,
  AgentSink,
  ApprovalDecision,
  InboundEnvelope,
} from "@finalbot/core";
import { FinalBotDatabase } from "@finalbot/db";
import { loadConfig } from "./config";
import { EventBus } from "./event-bus";
import { OwnerService } from "./owner-service";
import { RunService, type RunToolProvider } from "./run-service";

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
        replyAddress: {
          channelId: "onebot",
          accountId: "bot",
          data: { messageType: "private", userId: "restart" },
        },
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
    service.setReplySender(async (_address, message) => {
      if (!connected) throw new Error("offline");
      delivered.push(message.text);
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
    service.setReplySender(async (_address, message) => {
      replies.push(message.text);
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
    service.setReplySender(async (_address, message) => {
      replies.push(message.text);
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

describe("durable messages and workspace modes", () => {
  test("reuses Web Codex threads until the tool snapshot changes", async () => {
    const env = await setup();
    const agent = new InspectingAgent();
    const provider = mutableToolProvider("snapshot-a");
    const service = new RunService(env.db, new EventBus(), env.config, agent);
    service.setToolProvider(provider);

    try {
      const first = await service.createWebRun("first");
      const finished = await waitFor(() => {
        const run = env.db.getRun(first.id);
        return run?.state === "succeeded" ? run : null;
      });
      await waitFor(() => (agent.inputs.length === 1 ? true : null));

      await service.createWebRun("second");
      await waitFor(() => (agent.inputs.length === 2 ? true : null));
      expect(agent.inputs[1]?.nativeThreadId).toBe(finished.nativeThreadId ?? undefined);

      provider.setHash("snapshot-b");
      await service.createWebRun("third");
      await waitFor(() => (agent.inputs.length === 3 ? true : null));
      expect(agent.inputs[2]?.nativeThreadId ?? undefined).toBeUndefined();
      expect(agent.inputs[2]?.prompt).toContain("Tool snapshot changed");
    } finally {
      await service.close();
      env.db.close();
    }
  });

  test("creates a Web run without a git repository and links both sides of the conversation", async () => {
    const root = await mkdtemp(join(tmpdir(), "finalbot-web-run-"));
    tempDirs.push(root);
    const db = new FinalBotDatabase(join(root, "test.sqlite"));
    const config = loadConfig({
      FINALBOT_DATA_DIR: join(root, "data"),
      FINALBOT_FAKE_AGENT: "1",
    });
    db.upsertBotProfile({
      id: "assistant",
      name: "Assistant",
      description: "Web assistant",
      instructions: "Answer clearly.",
      agent: "codex",
      workspaceMode: "none",
    });
    const service = new RunService(db, new EventBus(), config, new InspectingAgent());

    try {
      const created = await service.createWebRun("hello from web", "assistant");
      expect(created.trigger).toBe("web");
      const run = await waitFor(() => {
        const current = db.getRun(created.id);
        return current?.state === "succeeded" ? current : null;
      });
      expect(run.workspaceMode).toBe("none");
      expect(db.listRunMessages(run.id).map((item) => item.role)).toEqual(["user", "assistant"]);
      expect(db.listRunMessages(run.id)[0]?.text).toBe("hello from web");
      expect(db.listRunMessages(run.id)[1]?.text).toBe("done");
    } finally {
      await service.close();
      db.close();
    }
  });

  test("marks scheduler-created runs with a schedule trigger and links the trigger message", async () => {
    const env = await setup();
    const conversation = env.db.upsertConversation({
      channel: "web",
      accountId: "local",
      externalId: "schedule-source",
      conversationKind: "private",
    });
    const trigger = env.db.insertMessage({
      conversationId: conversation.id,
      channelId: "web",
      accountId: "local",
      externalConversationId: "schedule-source",
      role: "system",
      text: "Scheduled task",
      metadata: { kind: "schedule" },
    }).message;
    const service = new RunService(env.db, new EventBus(), env.config, new InspectingAgent());

    try {
      await service.admitStoredMessages(conversation.id, "coder", [trigger.id], "schedule");
      const run = await waitFor(() => {
        const current = env.db.listRuns()[0];
        return current?.state === "succeeded" ? current : null;
      });
      expect(run.trigger).toBe("schedule");
      expect(env.db.listRunMessages(run.id).map((item) => item.id)).toContain(trigger.id);
    } finally {
      await service.close();
      env.db.close();
    }
  });

  test("only accepts pairing codes from Owner private chat", async () => {
    const env = await setup();
    const owner = new OwnerService(env.db);
    const code = owner.createPairingCode().code;
    const groupMessage: InboundEnvelope = {
      ...message("pair-group", `/pair ${code}`),
      conversationKind: "group",
      externalConversationId: "group:test",
      replyAddress: {
        channelId: "onebot",
        accountId: "bot",
        data: { messageType: "group", groupId: "test" },
      },
    };

    try {
      expect(owner.pairFromMessage(groupMessage)).toMatchObject({ ok: false });
      expect(owner.isOwner(groupMessage)).toBe(false);
      expect(owner.pairFromMessage(message("pair-private", `/pair ${code}`))).toMatchObject({
        ok: true,
      });
      expect(owner.isOwner(message("pair-private", "already paired"))).toBe(true);
    } finally {
      env.db.close();
    }
  });

  test("allows the paired Owner to approve a group run requested by a member", async () => {
    const env = await setup();
    const agent = new ApprovalTestAgent();
    const owner = env.db.ensureOwner();
    env.db.bindOwnerIdentity({
      ownerId: owner.id,
      channelId: "onebot",
      accountId: "bot",
      senderId: "10001",
      conversationKind: "private",
      aliases: ["owner-union"],
      replyAddress: {
        channelId: "onebot",
        accountId: "bot",
        data: { messageType: "private", userId: "10001" },
      },
    });
    const service = new RunService(env.db, new EventBus(), env.config, agent);
    service.setReplySender(async () => undefined);
    const group = {
      ...message("group-prompt", "make a change"),
      conversationKind: "group" as const,
      externalConversationId: "group:owner-approval",
      senderId: "member-2",
      replyAddress: {
        channelId: "onebot",
        accountId: "bot",
        data: { messageType: "group", groupId: "owner-approval" },
      },
    };

    try {
      await service.admitInbound(group);
      const approval = await waitFor(() => pending(env.db));
      await service.admitInbound({
        ...group,
        externalMessageId: "group-approve",
        senderId: "10001",
        text: "/approve",
      });
      const run = await waitFor(() => {
        const current = env.db.listRuns()[0];
        return current?.state === "succeeded" ? current : null;
      });
      expect(run.requestedBy).toBe("member-2");
      expect(agent.decisions).toEqual([{ action: "accept" }]);
      expect(env.db.getApproval(approval.requestId)?.status).toBe("accepted");
    } finally {
      await service.close();
      env.db.close();
    }
  });
});

describe("Sub Agent and Cross-Bot orchestration", () => {
  test("runs a Sub Agent in the parent workspace with an isolated thread and context", async () => {
    const env = await setup();
    const conversation = env.db.upsertConversation({
      channel: "onebot",
      accountId: "bot",
      externalId: "private:subagent",
      conversationKind: "private",
    });
    const parent = env.db.createRun({
      conversationId: conversation.id,
      prompt: "parent task",
      requestedBy: "10001",
      botId: "coder",
      botName: "Coder",
      botInstructions: "Parent instructions",
      agent: "codex",
    });
    env.db.updateRun(parent.id, {
      state: "running",
      workspacePath: env.config.repositoryPath,
      nativeThreadId: "thread_parent",
    });
    const agent = new OrchestrationTestAgent('{"summary":"child complete","tests":"passed"}');
    const service = new RunService(env.db, new EventBus(), env.config, agent);
    const replies: string[] = [];
    service.setReplySender(async (_address, message) => {
      replies.push(message.text);
    });

    try {
      const result = await service.orchestration().spawnSubagent({
        parentRunId: parent.id,
        prompt: "inspect the parser",
      });
      expect(result).toMatchObject({
        kind: "subagent",
        status: "succeeded",
        summary: {
          summary: "child complete",
          tests: "passed",
        },
      });
      if (!result.runId) throw new Error("Sub Agent did not create a child Run");
      const child = env.db.getRun(result.runId);
      if (!child) throw new Error("Sub Agent child Run was not persisted");
      expect(child).toMatchObject({
        parentRunId: parent.id,
        trigger: "subagent",
        botId: "coder",
        workspacePath: env.config.repositoryPath,
      });
      expect(child?.nativeThreadId).toBe(`thread_${child?.id}`);
      expect(agent.inputs).toHaveLength(1);
      expect(agent.inputs[0]).toMatchObject({
        cwd: env.config.repositoryPath,
        prompt: "inspect the parser",
      });
      expect(agent.inputs[0]?.nativeThreadId).toBeUndefined();
      expect(env.db.getLatestConversationSession(conversation.id, "coder")).toEqual({
        nativeThreadId: "thread_parent",
      });
      expect(env.db.listSubagentTasks(parent.id)[0]).toMatchObject({
        childRunId: child?.id,
        status: "succeeded",
        result: {
          kind: "subagent",
          status: "succeeded",
          summary: { summary: "child complete", tests: "passed" },
        },
      });
      expect(replies).toHaveLength(0);
    } finally {
      await service.close();
      env.db.close();
    }
  });

  test("rejects nested Sub Agents and Cross-Bot dispatch from a Sub Agent", async () => {
    const env = await setup();
    env.db.upsertBotProfile({
      id: "reviewer",
      name: "Reviewer",
      description: "Reviews changes",
      instructions: "Review code.",
      agent: "codex",
    });
    const conversation = env.db.upsertConversation({
      channel: "onebot",
      accountId: "bot",
      externalId: "private:subagent-recursion",
      conversationKind: "private",
    });
    const root = env.db.createRun({
      conversationId: conversation.id,
      prompt: "root",
      botId: "coder",
      botName: "Coder",
      agent: "codex",
    });
    const child = env.db.createRun({
      conversationId: conversation.id,
      prompt: "child",
      botId: "coder",
      botName: "Coder",
      agent: "codex",
      trigger: "subagent",
      parentRunId: root.id,
    });
    env.db.updateRun(child.id, {
      state: "running",
      workspacePath: env.config.repositoryPath,
    });
    const service = new RunService(
      env.db,
      new EventBus(),
      env.config,
      new OrchestrationTestAgent("{}"),
    );

    try {
      await expect(
        service.orchestration().spawnSubagent({
          parentRunId: child.id,
          prompt: "nested",
        }),
      ).rejects.toThrow("cannot spawn nested");
      await expect(
        service.orchestration().dispatchToBot({
          sourceRunId: child.id,
          targetBotId: "reviewer",
          prompt: "handoff",
        }),
      ).rejects.toThrow("Sub Agents cannot dispatch");
    } finally {
      await service.close();
      env.db.close();
    }
  });

  test("enforces Sub Agent concurrency and total limits", async () => {
    const env = await setup();
    const conversation = env.db.upsertConversation({
      channel: "onebot",
      accountId: "bot",
      externalId: "private:subagent-limits",
      conversationKind: "private",
    });
    const parent = env.db.createRun({
      conversationId: conversation.id,
      prompt: "parent",
      botId: "coder",
      botName: "Coder",
      agent: "codex",
    });
    env.db.updateRun(parent.id, {
      state: "running",
      workspacePath: env.config.repositoryPath,
    });
    const agent = new OrchestrationTestAgent('{"summary":"ok"}', { delayMs: 80 });
    const service = new RunService(env.db, new EventBus(), env.config, agent, {
      maxConcurrentSubagents: 1,
      maxSubagentsPerParent: 2,
      subagentTimeoutMs: 1_000,
    });

    try {
      const first = service.orchestration().spawnSubagent({
        parentRunId: parent.id,
        prompt: "first",
      });
      await expect(
        service.orchestration().spawnSubagent({
          parentRunId: parent.id,
          prompt: "parallel",
        }),
      ).rejects.toThrow("concurrency limit");
      await expect(first).resolves.toMatchObject({ status: "succeeded" });

      await expect(
        service.orchestration().spawnSubagent({
          parentRunId: parent.id,
          prompt: "second",
        }),
      ).resolves.toMatchObject({ status: "succeeded" });
      await expect(
        service.orchestration().spawnSubagent({
          parentRunId: parent.id,
          prompt: "total overflow",
        }),
      ).rejects.toThrow("total limit");
    } finally {
      await service.close();
      env.db.close();
    }
  });

  test("times out and interrupts a Sub Agent after its deadline", async () => {
    const env = await setup();
    const conversation = env.db.upsertConversation({
      channel: "onebot",
      accountId: "bot",
      externalId: "private:subagent-timeout",
      conversationKind: "private",
    });
    const parent = env.db.createRun({
      conversationId: conversation.id,
      prompt: "parent",
      botId: "coder",
      botName: "Coder",
      agent: "codex",
    });
    env.db.updateRun(parent.id, {
      state: "running",
      workspacePath: env.config.repositoryPath,
    });
    const agent = new OrchestrationTestAgent('{"summary":"late"}', {
      waitForInterrupt: true,
    });
    const service = new RunService(env.db, new EventBus(), env.config, agent, {
      subagentTimeoutMs: 30,
    });

    try {
      const result = await service.orchestration().spawnSubagent({
        parentRunId: parent.id,
        prompt: "hang",
      });
      expect(result).toMatchObject({
        status: "timed_out",
        error: expect.stringContaining("exceeded"),
      });
      await waitFor(() => (agent.interrupted ? true : null));
      expect(env.db.listSubagentTasks(parent.id)[0]?.status).toBe("timed_out");
    } finally {
      await service.close();
      env.db.close();
    }
  });

  test("persists a Cross-Bot handoff and creates a target Run", async () => {
    const env = await setup();
    env.db.upsertBotProfile({
      id: "reviewer",
      name: "Reviewer",
      description: "Reviews changes",
      instructions: "Review code.",
      agent: "codex",
    });
    const conversation = env.db.upsertConversation({
      channel: "onebot",
      accountId: "bot",
      externalId: "private:cross-bot-dispatch",
      conversationKind: "private",
    });
    const source = env.db.createRun({
      conversationId: conversation.id,
      prompt: "source",
      requestedBy: "10001",
      botId: "coder",
      botName: "Coder",
      agent: "codex",
    });
    env.db.updateRun(source.id, { state: "running", workspacePath: env.config.repositoryPath });
    const agent = new OrchestrationTestAgent('{"summary":"review complete"}');
    const service = new RunService(env.db, new EventBus(), env.config, agent);

    try {
      const result = await service.orchestration().dispatchToBot({
        sourceRunId: source.id,
        targetBotId: "reviewer",
        prompt: "review auth",
      });
      expect(result).toMatchObject({
        kind: "cross-bot",
        status: "succeeded",
        summary: { summary: "review complete" },
      });
      if (!result.runId) throw new Error("Cross-Bot dispatch did not create a target Run");
      const target = env.db.getRun(result.runId);
      if (!target) throw new Error("Cross-Bot target Run was not persisted");
      expect(target).toMatchObject({
        parentRunId: source.id,
        trigger: "agent-message",
        botId: "reviewer",
      });
      expect(env.db.findAgentMessageByTargetRunId(target.id)).toMatchObject({
        sourceRunId: source.id,
        targetBotId: "reviewer",
        hopCount: 1,
        status: "succeeded",
      });
      await expect(
        service.orchestration().dispatchToBot({
          sourceRunId: source.id,
          targetBotId: "reviewer",
          prompt: "review auth",
        }),
      ).rejects.toThrow("Duplicate");
    } finally {
      await service.close();
      env.db.close();
    }
  });

  test("detects Cross-Bot cycles, hop limits, and dispatch fan-out limits", async () => {
    const env = await setup();
    for (const id of ["builder", "reviewer", "writer", "finalizer", "observer"]) {
      env.db.upsertBotProfile({
        id,
        name: id,
        description: id,
        instructions: id,
        agent: "codex",
      });
    }
    const conversation = env.db.upsertConversation({
      channel: "onebot",
      accountId: "bot",
      externalId: "private:cross-bot-cycle",
      conversationKind: "private",
    });
    const root = env.db.createRun({
      conversationId: conversation.id,
      prompt: "root",
      botId: "coder",
      botName: "Coder",
      agent: "codex",
    });
    const reviewer = env.db.createRun({
      conversationId: conversation.id,
      prompt: "review",
      botId: "reviewer",
      botName: "reviewer",
      agent: "codex",
      trigger: "agent-message",
      parentRunId: root.id,
    });
    const builder = env.db.createRun({
      conversationId: conversation.id,
      prompt: "build",
      botId: "builder",
      botName: "builder",
      agent: "codex",
      trigger: "agent-message",
      parentRunId: reviewer.id,
    });
    const writer = env.db.createRun({
      conversationId: conversation.id,
      prompt: "write",
      botId: "writer",
      botName: "writer",
      agent: "codex",
      trigger: "agent-message",
      parentRunId: builder.id,
    });
    env.db.updateRun(root.id, { state: "running", workspacePath: env.config.repositoryPath });
    env.db.updateRun(reviewer.id, {
      state: "running",
      workspacePath: env.config.repositoryPath,
    });
    env.db.updateRun(writer.id, {
      state: "running",
      workspacePath: env.config.repositoryPath,
    });
    const service = new RunService(
      env.db,
      new EventBus(),
      env.config,
      new OrchestrationTestAgent("{}"),
    );

    try {
      await expect(
        service.orchestration().dispatchToBot({
          sourceRunId: reviewer.id,
          targetBotId: "coder",
          prompt: "return to coder",
        }),
      ).rejects.toThrow("cycle");
      await expect(
        service.orchestration().dispatchToBot({
          sourceRunId: writer.id,
          targetBotId: "finalizer",
          prompt: "fourth hop",
        }),
      ).rejects.toThrow("hop limit");

      for (let index = 0; index < 5; index += 1) {
        env.db.createAgentMessage({
          sourceRunId: root.id,
          rootRunId: root.id,
          sourceBotId: "coder",
          targetBotId: "observer",
          prompt: `fan-out ${index}`,
          hopCount: 1,
          dedupeKey: `fan-out-${index}`,
          maxHops: 3,
          maxPerParent: 5,
        });
      }
      await expect(
        service.orchestration().dispatchToBot({
          sourceRunId: root.id,
          targetBotId: "finalizer",
          prompt: "one too many",
        }),
      ).rejects.toThrow("dispatch limit");
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

function mutableToolProvider(initialHash: string): RunToolProvider & {
  setHash(hash: string): void;
} {
  let hash = initialHash;
  return {
    current: () => ({ revision: 1, hash, tools: [] }),
    specs: () => [],
    call: async () => ({
      success: false,
      contentItems: [{ type: "inputText", text: '{"error":"unused"}' }],
    }),
    setHash(nextHash) {
      hash = nextHash;
    },
  };
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

class OrchestrationTestAgent implements AgentAdapter {
  readonly inputs: Parameters<AgentAdapter["start"]>[0][] = [];
  interrupted = false;
  private release: (() => void) | null = null;

  constructor(
    private readonly output: string,
    private readonly options: { delayMs?: number; waitForInterrupt?: boolean } = {},
  ) {}

  start(input: Parameters<AgentAdapter["start"]>[0], sink: AgentSink): AgentRunHandle {
    this.inputs.push(input);
    const nativeThreadId = `thread_${input.runId}`;
    const nativeTurnId = `turn_${input.runId}`;
    const result = (async () => {
      await sink.event({ type: "thread", nativeThreadId });
      await sink.event({ type: "turn", nativeTurnId });
      if (this.options.waitForInterrupt) {
        await new Promise<void>((resolve) => {
          this.release = resolve;
        });
      } else if (this.options.delayMs) {
        await Bun.sleep(this.options.delayMs);
      }
      if (this.interrupted) {
        return {
          status: "interrupted" as const,
          nativeThreadId,
          nativeTurnId,
          output: "",
        };
      }
      await sink.event({ type: "delta", text: this.output });
      return {
        status: "succeeded" as const,
        nativeThreadId,
        nativeTurnId,
        output: this.output,
      };
    })();
    return {
      result,
      interrupt: async () => {
        this.interrupted = true;
        this.release?.();
      },
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

function message(id: string, text: string): InboundEnvelope {
  return {
    channelId: "onebot",
    accountId: "bot",
    externalConversationId: "private:10001",
    conversationKind: "private",
    externalMessageId: id,
    senderId: "10001",
    text,
    mentions: [],
    botMentioned: false,
    botRepliedTo: false,
    raw: {},
    receivedAt: new Date().toISOString(),
    replyAddress: {
      channelId: "onebot",
      accountId: "bot",
      data: { messageType: "private", userId: "10001" },
    },
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
