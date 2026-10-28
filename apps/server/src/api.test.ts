import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryService, ScratchpadService, ToolRegistry } from "@finalbot/agent-runtime";
import { ChannelRegistry } from "@finalbot/core";
import { FinalBotDatabase } from "@finalbot/db";
import { loadConfig } from "./config";
import { EventBus } from "./event-bus";
import { assertAdminBinding, createApp } from "./index";
import { OwnerService } from "./owner-service";
import { RunService } from "./run-service";
import { WebChannelAdapter } from "./web-channel";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("HTTP API", () => {
  test("serves channel health and requires the admin bearer token", async () => {
    const env = await setup();
    try {
      const health = await env.app.request("/api/health", {
        headers: { Authorization: "Bearer test-admin" },
      });
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({
        ok: true,
        channels: [
          {
            id: "web",
            type: "web",
            enabled: true,
            configured: true,
          },
        ],
      });

      const unauthorized = await env.app.request("/api/runs");
      expect(unauthorized.status).toBe(401);
      const authorized = await env.app.request("/api/runs", {
        headers: { Authorization: "Bearer test-admin" },
      });
      expect(authorized.status).toBe(200);
    } finally {
      await env.close();
    }
  });

  test("persists conversation policy and exposed memory through the API", async () => {
    const env = await setup();
    try {
      const conversation = env.db.upsertConversation({
        channel: "web",
        accountId: "local",
        externalId: "api-policy",
        conversationKind: "group",
      });
      const policyResponse = await env.app.request(`/api/conversations/${conversation.id}/policy`, {
        method: "PUT",
        headers: {
          Authorization: "Bearer test-admin",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ observeAll: true, discussEnabled: false }),
      });
      expect(policyResponse.status).toBe(200);
      expect(await policyResponse.json()).toMatchObject({
        observeAll: true,
        discussEnabled: false,
      });

      const writeResponse = await env.app.request("/api/memory", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-admin",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          scope: "owner",
          kind: "preference",
          content: "Use concise replies",
          tags: ["style", "style-guide"],
        }),
      });
      expect(writeResponse.status).toBe(201);

      const searchResponse = await env.app.request("/api/memory?query=concise&tag=style", {
        headers: { Authorization: "Bearer test-admin" },
      });
      expect(searchResponse.status).toBe(200);
      const found = (await searchResponse.json()) as Array<{ content: string }>;
      expect(found.map((memory) => memory.content)).toContain("Use concise replies");
    } finally {
      await env.close();
    }
  });

  test("enforces scratchpad revisions and exposes run audit data", async () => {
    const env = await setup();
    try {
      const conversation = env.db.upsertConversation({
        channel: "web",
        accountId: "local",
        externalId: "api-audit",
        conversationKind: "private",
      });
      const first = await env.app.request(`/api/scratchpads/${conversation.id}/coder`, {
        method: "PUT",
        headers: {
          Authorization: "Bearer test-admin",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: { step: 1 }, expectedRevision: 0 }),
      });
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ revision: 1, content: { step: 1 } });

      const stale = await env.app.request(`/api/scratchpads/${conversation.id}/coder`, {
        method: "PUT",
        headers: {
          Authorization: "Bearer test-admin",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: { step: 2 }, expectedRevision: 0 }),
      });
      expect(stale.status).toBe(409);

      const run = env.db.createRun({
        conversationId: conversation.id,
        prompt: "audit this run",
        requestedBy: "member-1",
        botId: "coder",
        botName: "Coder",
        agent: "codex",
      });
      const message = env.db.insertMessage({
        conversationId: conversation.id,
        channelId: "web",
        accountId: "local",
        externalConversationId: "api-audit",
        role: "user",
        senderId: "member-1",
        text: "audit this run",
      }).message;
      env.db.linkRunMessages(run.id, [message.id]);
      const toolCall = env.db.createToolCall({
        runId: run.id,
        namespace: "memory",
        tool: "search",
        arguments: { query: "audit" },
      });
      env.db.finishToolCall({
        id: toolCall.id,
        status: "succeeded",
        result: [{ scope: "owner" }],
      });
      const batch = env.db.openDiscussBatch({
        conversationId: conversation.id,
        botId: "coder",
        messageId: message.id,
        debounceMs: 0,
        maxWaitMs: 1_000,
      });
      env.db.finishDiscussBatch({
        batchId: batch.id,
        action: "send",
        reason: "useful contribution",
        confidence: 0.9,
        messageIds: [message.id],
        runId: run.id,
      });

      const detail = await env.app.request(`/api/runs/${run.id}`, {
        headers: { Authorization: "Bearer test-admin" },
      });
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({
        id: run.id,
        messages: [expect.objectContaining({ text: "audit this run", role: "user" })],
        toolCalls: [
          expect.objectContaining({
            namespace: "memory",
            tool: "search",
            status: "succeeded",
          }),
        ],
        discussDecisions: [
          expect.objectContaining({
            action: "send",
            runId: run.id,
            reason: "useful contribution",
          }),
        ],
      });
    } finally {
      await env.close();
    }
  });

  test("stores MCP environment references without exposing resolved credentials", async () => {
    const env = await setup();
    try {
      const created = await env.app.request("/api/mcp/servers", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-admin",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: "demo",
          name: "Demo MCP",
          transport: "http",
          url: "https://example.com/mcp",
          envRefs: { TOKEN: "FINALBOT_TEST_MCP_TOKEN" },
          headers: { Authorization: "FINALBOT_TEST_MCP_AUTH" },
        }),
      });
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({
        id: "demo",
        status: "disconnected",
        envRefs: { TOKEN: "FINALBOT_TEST_MCP_TOKEN" },
        envRefsConfigured: { TOKEN: false },
        headersConfigured: { Authorization: false },
      });

      const listed = await env.app.request("/api/mcp/servers", {
        headers: { Authorization: "Bearer test-admin" },
      });
      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual([
        expect.objectContaining({
          id: "demo",
          envRefsConfigured: { TOKEN: false },
          headersConfigured: { Authorization: false },
        }),
      ]);

      const removed = await env.app.request("/api/mcp/servers/demo", {
        method: "DELETE",
        headers: { Authorization: "Bearer test-admin" },
      });
      expect(removed.status).toBe(204);
    } finally {
      await env.close();
    }
  });

  test("requires an admin token for non-loopback listeners", () => {
    expect(() => assertAdminBinding("127.0.0.1", null)).not.toThrow();
    expect(() => assertAdminBinding("::1", null)).not.toThrow();
    expect(() => assertAdminBinding("0.0.0.0", null)).toThrow("FINALBOT_ADMIN_TOKEN");
    expect(() => assertAdminBinding("0.0.0.0", "secret")).not.toThrow();
  });
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "finalbot-api-"));
  tempDirs.push(dir);
  const config = loadConfig({
    FINALBOT_DATA_DIR: dir,
    FINALBOT_FAKE_AGENT: "1",
  });
  const db = new FinalBotDatabase(join(dir, "test.sqlite"));
  const bus = new EventBus();
  const runs = new RunService(db, bus, config);
  const owner = new OwnerService(db);
  const tools = new ToolRegistry({
    db,
    memory: new MemoryService(db),
    scratchpad: new ScratchpadService(db),
  });
  const channels = new ChannelRegistry();
  channels.register(new WebChannelAdapter(), () => undefined);
  const app = createApp(db, bus, runs, () => channels.states(), null, "test-admin", owner, tools);
  return {
    app,
    db,
    async close() {
      await runs.close();
      db.close();
    },
  };
}
