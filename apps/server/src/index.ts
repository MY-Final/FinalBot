import { mkdir } from "node:fs/promises";
import {
  DiscussService,
  MemoryService,
  Scheduler,
  ScratchpadService,
  ToolRegistry,
} from "@finalbot/agent-runtime";
import { OneBotAdapter } from "@finalbot/channel-onebot";
import { QqOfficialAdapter } from "@finalbot/channel-qq";
import { QuickJsCodeSandbox } from "@finalbot/code-sandbox";
import {
  ChannelRegistry,
  type ChannelState,
  createId,
  nowIso,
  type ToolSnapshot,
} from "@finalbot/core";
import { FinalBotDatabase, type McpServerRecord } from "@finalbot/db";
import { McpManager } from "@finalbot/mcp-client";
import type { HealthResponse, ServerEvent } from "@finalbot/protocol";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { z } from "zod";
import { ChannelGateway } from "./channel-gateway";
import { loadConfig } from "./config";
import { EventBus } from "./event-bus";
import { OwnerService } from "./owner-service";
import { SqliteQqSessionStore } from "./qq-session-store";
import { RunService } from "./run-service";
import { WebChannelAdapter } from "./web-channel";

export function createApp(
  db: FinalBotDatabase,
  bus: EventBus,
  runs: RunService,
  channelState: () => ChannelState[],
  repositoryPath: string | null,
  adminToken: string | null = null,
  owner: OwnerService | null = null,
  tools: ToolRegistry | null = null,
  startedAt = Date.now(),
  mcp: McpManager | null = null,
): Hono {
  const app = new Hono();
  const memoryService = new MemoryService(db);
  const scratchpadService = new ScratchpadService(db);

  app.use("*", async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    if (
      adminToken &&
      c.req.path.startsWith("/api/") &&
      !isAuthorized(c.req.header("Authorization"), adminToken)
    ) {
      return c.json({ error: "unauthorized", message: "Admin token is required" }, 401);
    }
    await next();
  });

  app.get("/api/health", (c) => {
    const response: HealthResponse = {
      ok: true,
      version: "0.1.0",
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      channels: channelState(),
      repository: {
        configured: repositoryPath !== null,
        path: repositoryPath,
      },
    };
    return c.json(response);
  });

  app.get("/api/runs", (c) => {
    const rows = db.listRuns();
    return c.json(rows.map(toRunSummary));
  });

  app.get("/api/bots", (c) => {
    return c.json(
      db.listBotProfiles().map((bot) => ({
        id: bot.id,
        name: bot.name,
        description: bot.description,
        agent: bot.agent,
        model: bot.model,
        enabled: bot.enabled,
        workspaceMode: bot.workspaceMode,
      })),
    );
  });

  app.get("/api/channels", (c) => c.json(channelState()));

  app.get("/api/messages", (c) => {
    const conversationId = c.req.query("conversationId");
    if (!conversationId) return c.json([]);
    return c.json(db.listMessages(conversationId, Number(c.req.query("limit") ?? 50)));
  });

  app.get("/api/conversations", (c) => {
    return c.json(
      db.listConversations(Number(c.req.query("limit") ?? 100)).map((conversation) => ({
        ...conversation,
        policy: db.getConversationPolicy(conversation.id),
      })),
    );
  });

  app.get("/api/conversations/:id/policy", (c) => {
    if (!db.getConversation(c.req.param("id"))) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json(db.getConversationPolicy(c.req.param("id")));
  });

  const conversationPolicyInput = z.object({
    observeAll: z.boolean(),
    discussEnabled: z.boolean(),
  });

  app.put("/api/conversations/:id/policy", async (c) => {
    if (!db.getConversation(c.req.param("id"))) {
      return c.json({ error: "not_found" }, 404);
    }
    const parsed = conversationPolicyInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", message: parsed.error.message }, 400);
    }
    return c.json(
      db.setConversationPolicy({
        conversationId: c.req.param("id"),
        observeAll: parsed.data.observeAll,
        discussEnabled: parsed.data.discussEnabled,
      }),
    );
  });

  app.get("/api/memory", (c) => {
    const scope = c.req.query("scope");
    const botId = c.req.query("botId");
    const kind = c.req.query("kind");
    const tag = c.req.query("tag");
    const query = c.req.query("query");
    return c.json(
      db.listMemories({
        ...(scope === "owner" || scope === "bot" ? { scope: scope as "owner" | "bot" } : {}),
        ...(botId ? { botId } : {}),
        ...(kind ? { kind } : {}),
        ...(tag ? { tag } : {}),
        ...(query ? { query } : {}),
        includeDeleted: c.req.query("includeDeleted") === "1",
      }),
    );
  });

  const memoryInput = z.object({
    scope: z.enum(["owner", "bot"]),
    botId: z.string().nullable().optional(),
    kind: z.string().min(1),
    content: z
      .string()
      .min(1)
      .max(16 * 1024),
    tags: z.array(z.string()).optional(),
    confidence: z.number().min(0).max(1).optional(),
  });

  app.post("/api/memory", async (c) => {
    const parsed = memoryInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", message: parsed.error.message }, 400);
    }
    try {
      if (!tools || !owner) throw new Error("Memory service unavailable");
      const result = new MemoryService(db).write(
        {
          scope: parsed.data.scope,
          kind: parsed.data.kind,
          content: parsed.data.content,
          tags: parsed.data.tags ?? [],
          ...(parsed.data.confidence !== undefined ? { confidence: parsed.data.confidence } : {}),
        },
        {
          runId: webMemoryAuditRunId(db),
          conversationId: webConversationId(db),
          botId: parsed.data.botId ?? "coder",
          ownerId: owner.ownerId,
        },
      );
      return c.json(result, 201);
    } catch (error) {
      return c.json({ error: "memory_write_failed", message: errorMessage(error) }, 400);
    }
  });

  const memoryUpdateInput = z
    .object({
      scope: z.enum(["owner", "bot"]).optional(),
      botId: z.string().nullable().optional(),
      kind: z.string().min(1).optional(),
      content: z
        .string()
        .min(1)
        .max(16 * 1024)
        .optional(),
      tags: z.array(z.string()).optional(),
      confidence: z.number().min(0).max(1).optional(),
    })
    .refine((value) => Object.keys(value).length > 0, "At least one field is required");

  app.put("/api/memory/:id", async (c) => {
    const parsed = memoryUpdateInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", message: parsed.error.message }, 400);
    }
    try {
      return c.json(
        memoryService.update(c.req.param("id"), {
          ...(parsed.data.scope ? { scope: parsed.data.scope } : {}),
          ...(parsed.data.botId !== undefined ? { botId: parsed.data.botId } : {}),
          ...(parsed.data.kind ? { kind: parsed.data.kind } : {}),
          ...(parsed.data.content ? { content: parsed.data.content } : {}),
          ...(parsed.data.tags ? { tags: parsed.data.tags } : {}),
          ...(parsed.data.confidence !== undefined ? { confidence: parsed.data.confidence } : {}),
        }),
      );
    } catch (error) {
      return c.json({ error: "memory_update_failed", message: errorMessage(error) }, 400);
    }
  });

  app.delete("/api/memory/:id", (c) => {
    const permanent = c.req.query("permanent") === "1";
    db.setMemoryStatus(c.req.param("id"), "deleted");
    if (permanent) db.deleteMemoryPermanently(c.req.param("id"));
    return c.body(null, 204);
  });

  app.get("/api/scratchpads", (c) => {
    const conversationId = c.req.query("conversationId");
    return c.json(scratchpadService.list(conversationId || undefined));
  });

  app.get("/api/scratchpads/:conversationId/:botId", (c) => {
    const result = scratchpadService.get(c.req.param("conversationId"), c.req.param("botId"));
    return result ? c.json(result) : c.json({ error: "not_found" }, 404);
  });

  const scratchpadInput = z.object({
    content: z.unknown(),
    expectedRevision: z.number().int().min(0).optional(),
    ttlDays: z.number().positive().max(90).optional(),
  });

  app.put("/api/scratchpads/:conversationId/:botId", async (c) => {
    const parsed = scratchpadInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", message: parsed.error.message }, 400);
    }
    try {
      return c.json(
        scratchpadService.set({
          conversationId: c.req.param("conversationId"),
          botId: c.req.param("botId"),
          content: parsed.data.content,
          ...(parsed.data.expectedRevision !== undefined
            ? { expectedRevision: parsed.data.expectedRevision }
            : {}),
          ...(parsed.data.ttlDays !== undefined ? { ttlDays: parsed.data.ttlDays } : {}),
        }),
      );
    } catch (error) {
      return c.json({ error: "scratchpad_write_failed", message: errorMessage(error) }, 409);
    }
  });

  app.delete("/api/scratchpads/:conversationId/:botId", (c) => {
    const deleted = scratchpadService.delete(c.req.param("conversationId"), c.req.param("botId"));
    return deleted ? c.body(null, 204) : c.json({ error: "not_found" }, 404);
  });

  app.get("/api/discuss/decisions", (c) => {
    const conversationId = c.req.query("conversationId") || undefined;
    return c.json(db.listDiscussDecisions(conversationId, Number(c.req.query("limit") ?? 50)));
  });

  app.get("/api/discuss/batches", (c) => {
    const conversationId = c.req.query("conversationId") || undefined;
    return c.json(db.listDiscussBatches(conversationId, Number(c.req.query("limit") ?? 20)));
  });

  app.get("/api/tools", (c) => {
    if (!tools) return c.json([]);
    const snapshot = tools.current();
    return c.json({
      revision: snapshot.revision,
      hash: snapshot.hash,
      tools: snapshot.tools.map((tool) => ({
        namespace: tool.namespace,
        name: tool.name,
        description: tool.description,
        policy: tool.policy,
      })),
    });
  });

  app.get("/api/tool-calls", (c) => {
    const runId = c.req.query("runId");
    return c.json(runId ? db.listToolCalls(runId) : []);
  });

  app.get("/api/mcp/servers", (c) => {
    const snapshot = tools?.current() ?? null;
    return c.json(
      db
        .listMcpServers(true)
        .map((server) => mcpServerSummary(server, snapshot, db.listMcpToolPolicies(server.id))),
    );
  });

  const mcpServerInput = z
    .object({
      id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/),
      name: z.string().trim().min(1).max(120),
      transport: z.enum(["stdio", "http"]),
      command: z.string().trim().min(1).nullable().optional(),
      args: z.array(z.string()).max(100).optional(),
      url: z.string().url().nullable().optional(),
      envRefs: z.record(z.string(), z.string()).optional(),
      headers: z.record(z.string(), z.string()).optional(),
      enabled: z.boolean().optional(),
    })
    .superRefine((value, context) => {
      if (value.transport === "stdio" && !value.command) {
        context.addIssue({
          code: "custom",
          path: ["command"],
          message: "stdio MCP servers require command",
        });
      }
      if (value.transport === "http" && !value.url) {
        context.addIssue({
          code: "custom",
          path: ["url"],
          message: "HTTP MCP servers require url",
        });
      }
    });

  app.post("/api/mcp/servers", async (c) => {
    const parsed = mcpServerInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", message: parsed.error.message }, 400);
    }
    try {
      const server = db.upsertMcpServer({
        id: parsed.data.id,
        name: parsed.data.name,
        transport: parsed.data.transport,
        command: parsed.data.command ?? null,
        args: parsed.data.args ?? [],
        url: parsed.data.url ?? null,
        envRefs: parsed.data.envRefs ?? {},
        headers: parsed.data.headers ?? {},
        ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
      });
      return c.json(
        mcpServerSummary(server, tools?.current() ?? null, db.listMcpToolPolicies(server.id)),
        201,
      );
    } catch (error) {
      return c.json({ error: "mcp_server_write_failed", message: errorMessage(error) }, 400);
    }
  });

  app.post("/api/mcp/reload", async (c) => {
    if (!mcp || !tools) return c.json({ error: "mcp_unavailable" }, 503);
    try {
      await mcp.reload();
      const snapshot = tools.replaceMcpTools(mcp.listTools());
      return c.json({
        revision: snapshot.revision,
        hash: snapshot.hash,
        servers: db
          .listMcpServers(true)
          .map((server) => mcpServerSummary(server, snapshot, db.listMcpToolPolicies(server.id))),
      });
    } catch (error) {
      return c.json({ error: "mcp_reload_failed", message: errorMessage(error) }, 502);
    }
  });

  const mcpPolicyInput = z.object({
    toolName: z.string().trim().min(1),
    policy: z.enum(["auto", "ask", "deny"]),
  });

  app.post("/api/mcp/servers/:id/policy", async (c) => {
    if (!mcp || !tools) return c.json({ error: "mcp_unavailable" }, 503);
    const parsed = mcpPolicyInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", message: parsed.error.message }, 400);
    }
    try {
      mcp.updateToolPolicy(c.req.param("id"), parsed.data.toolName, parsed.data.policy);
      const snapshot = tools.replaceMcpTools(mcp.listTools());
      return c.json(snapshot);
    } catch (error) {
      return c.json({ error: "mcp_policy_update_failed", message: errorMessage(error) }, 400);
    }
  });

  app.delete("/api/mcp/servers/:id", async (c) => {
    try {
      const removed = mcp
        ? await mcp.removeServer(c.req.param("id"))
        : db.deleteMcpServer(c.req.param("id"));
      if (!removed) return c.json({ error: "not_found" }, 404);
      if (mcp && tools) tools.replaceMcpTools(mcp.listTools());
      return c.body(null, 204);
    } catch (error) {
      return c.json({ error: "mcp_server_delete_failed", message: errorMessage(error) }, 400);
    }
  });

  app.get("/api/schedules", (c) => c.json(db.listSchedules()));

  const scheduleInput = z.object({
    name: z.string().min(1),
    expression: z.string().min(1),
    timezone: z.string().default("Asia/Shanghai"),
    conversationId: z.string().min(1),
    botId: z.string().min(1),
    prompt: z.string().min(1),
    nextRunAt: z.string().min(1),
  });

  app.post("/api/schedules", async (c) => {
    const parsed = scheduleInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", message: parsed.error.message }, 400);
    }
    try {
      const conversation = db.getConversation(parsed.data.conversationId);
      if (!conversation) throw new Error("Schedule conversation not found");
      const bot = db.getBotProfile(parsed.data.botId);
      if (!bot?.enabled) throw new Error("Schedule bot is not available");
      const channel = channelState().find((item) => item.id === conversation.channel);
      if (!channel?.capabilities.proactiveSend) {
        throw new Error(
          `Channel ${conversation.channel} does not support proactive schedule delivery`,
        );
      }
      const scheduler = new Scheduler({
        db,
        onDue: async () => undefined,
      });
      scheduler.validate(parsed.data.expression, parsed.data.timezone);
      const nextRunAt =
        scheduler.nextRun(
          {
            id: "preview",
            name: parsed.data.name,
            expression: parsed.data.expression,
            timezone: parsed.data.timezone,
            conversationId: parsed.data.conversationId,
            botId: parsed.data.botId,
            prompt: parsed.data.prompt,
            enabled: true,
            nextRunAt: null,
            lastRunAt: null,
            lastError: null,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          },
          new Date(),
        ) ?? parsed.data.nextRunAt;
      return c.json(
        db.createSchedule({
          id: createId("schedule"),
          ...parsed.data,
          nextRunAt,
        }),
        201,
      );
    } catch (error) {
      return c.json({ error: "schedule_create_failed", message: errorMessage(error) }, 400);
    }
  });

  app.post("/api/schedules/:id/toggle", (c) => {
    const schedule = db.getSchedule(c.req.param("id"));
    if (!schedule) return c.json({ error: "not_found" }, 404);
    return c.json(db.updateSchedule(schedule.id, { enabled: !schedule.enabled }));
  });

  app.post("/api/owner/pairing-code", (c) => {
    if (!owner) return c.json({ error: "owner_unavailable" }, 503);
    return c.json(owner.createPairingCode());
  });

  app.get("/api/runs/:id", (c) => {
    const run = db.getRun(c.req.param("id"));
    if (!run) return c.json({ error: "not_found", message: "Run not found" }, 404);
    return c.json({
      ...toRunSummary(run),
      approvals: db.listApprovals(run.id).map((approval) => ({
        requestId: approval.requestId,
        runId: approval.runId,
        kind: approval.kind,
        title: approval.title,
        detail: approval.detail,
        canAcceptForSession: approval.canAcceptForSession,
        status: approval.status,
        createdAt: approval.createdAt,
        resolvedAt: approval.resolvedAt,
      })),
      messages: db.listRunMessages(run.id).map((message) => ({
        id: message.id,
        role: message.role,
        senderId: message.senderId,
        senderName: message.senderName,
        text: message.text,
        createdAt: message.createdAt,
      })),
      toolCalls: db.listToolCalls(run.id),
      discussDecisions: db.listDiscussDecisions(run.conversationId, 20),
      phases: db.listPhases(run.id),
    });
  });

  const createRunSchema = z.object({
    prompt: z.string().trim().min(1).max(50_000),
    botId: z.string().trim().min(1).max(48).optional(),
  });

  app.post("/api/runs", async (c) => {
    const parsed = createRunSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", message: parsed.error.message }, 400);
    }
    try {
      const run = await runs.createWebRun(parsed.data.prompt, parsed.data.botId);
      return c.json(toRunSummary(run), 201);
    } catch (error) {
      return c.json(
        {
          error: "run_create_failed",
          message: error instanceof Error ? error.message : String(error),
        },
        400,
      );
    }
  });

  app.post("/api/runs/:id/interrupt", async (c) => {
    try {
      await runs.interrupt(c.req.param("id"));
      return c.body(null, 204);
    } catch (error) {
      return c.json(
        {
          error: "interrupt_failed",
          message: error instanceof Error ? error.message : String(error),
        },
        400,
      );
    }
  });

  const approvalSchema = z.object({
    action: z.enum(["accept", "accept_session", "decline", "cancel"]),
  });

  app.post("/api/approvals/:id/resolve", async (c) => {
    const parsed = approvalSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", message: parsed.error.message }, 400);
    }
    try {
      return c.json(runs.resolveApproval(c.req.param("id"), parsed.data));
    } catch (error) {
      return c.json(
        {
          error: "approval_resolve_failed",
          message: error instanceof Error ? error.message : String(error),
        },
        400,
      );
    }
  });

  app.get("/api/events", (c) => {
    const lastEventId = parseSequence(c.req.header("Last-Event-ID"));
    const queryAfter = parseSequence(c.req.query("after"));
    const requestedAfter = lastEventId ?? queryAfter;
    return c.body(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          let open = true;
          let replaying = true;
          const latest = db.latestEventSeq();
          let replayMax =
            requestedAfter !== null && requestedAfter <= latest ? requestedAfter : latest;
          const buffered: Array<{ seq: number; event: ServerEvent }> = [];
          const send = (seq: number | null, event: ServerEvent) => {
            if (!open) return;
            const id = seq === null ? "" : `id: ${seq}\n`;
            controller.enqueue(encoder.encode(`${id}data: ${JSON.stringify(event)}\n\n`));
          };
          const forward = (envelope: { seq: number | null; event: ServerEvent }) => {
            if (envelope.seq === null) {
              send(null, envelope.event);
              return;
            }
            if (replaying) {
              buffered.push({ seq: envelope.seq, event: envelope.event });
              return;
            }
            if (envelope.seq > replayMax) send(envelope.seq, envelope.event);
          };
          controller.enqueue(encoder.encode("retry: 1000\n\n"));
          send(null, {
            type: "system",
            level: "info",
            message: "connected",
            at: nowIso(),
          });
          const unsubscribe = bus.subscribe(forward);
          void (async () => {
            try {
              let cursor = replayMax;
              while (open) {
                const events = db.listEventsAfter(cursor);
                if (events.length === 0) break;
                for (const record of events) {
                  if (!open) return;
                  send(record.seq, record.payload as ServerEvent);
                  cursor = record.seq;
                }
                replayMax = cursor;
                if (events.length < 2000) break;
              }
            } catch (error) {
              console.error(`[finalbot] event replay failed: ${String(error)}`);
            } finally {
              replaying = false;
              buffered.sort((a, b) => a.seq - b.seq);
              for (const envelope of buffered) {
                if (envelope.seq > replayMax) send(envelope.seq, envelope.event);
              }
              buffered.length = 0;
            }
          })();
          const heartbeat = setInterval(() => {
            if (open) controller.enqueue(encoder.encode(": heartbeat\n\n"));
          }, 15_000);
          heartbeat.unref?.();
          c.req.raw.signal.addEventListener("abort", () => {
            open = false;
            clearInterval(heartbeat);
            unsubscribe();
            try {
              controller.close();
            } catch {
              // The stream may already be closed by the client.
            }
          });
        },
      }),
      200,
      {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    );
  });

  const webRoot = webAssetPath();
  if (webRoot) {
    app.use("/*", serveStatic({ root: webRoot }));
    app.get("*", serveStatic({ path: `${webRoot}/index.html` }));
  } else {
    const assets = embeddedWebAssets();
    app.get("*", (c) => {
      const pathname = c.req.path === "/" ? "/index.html" : c.req.path;
      const asset = assets.get(pathname);
      if (asset) return new Response(asset);
      const index = assets.get("/index.html");
      return index ? new Response(index) : c.notFound();
    });
  }

  return app;
}

async function main(): Promise<void> {
  const config = loadConfig();
  assertAdminBinding(config.host, config.adminToken);
  await mkdir(config.dataDir, { recursive: true });

  const db = new FinalBotDatabase(config.databasePath);
  const bus = new EventBus();
  const runs = new RunService(db, bus, config);
  const startedAt = Date.now();
  const owner = new OwnerService(db);
  const memory = new MemoryService(db);
  const scratchpad = new ScratchpadService(db);
  scratchpad.purgeExpired();
  const cleanupTimer = setInterval(
    () => {
      scratchpad.purgeExpired();
    },
    24 * 60 * 60_000,
  );
  cleanupTimer.unref?.();
  const tools = new ToolRegistry({
    db,
    memory,
    scratchpad,
    sandbox: new QuickJsCodeSandbox(),
    orchestration: {
      spawnSubagent: (prompt, context) =>
        runs.orchestration().spawnSubagent({
          parentRunId: context.runId,
          prompt,
        }),
      dispatchToBot: (targetBotId, prompt, context) =>
        runs.orchestration().dispatchToBot({
          sourceRunId: context.runId,
          targetBotId,
          prompt,
        }),
    },
  });
  const mcp = new McpManager({ db });
  const mcpTools = await mcp.reload();
  tools.replaceMcpTools(mcpTools);
  runs.setToolProvider(tools);
  const configuredOneBot = config.onebot.wsUrl.length > 0;

  let onebot: OneBotAdapter | null = null;

  const channels = new ChannelRegistry();
  const discuss = new DiscussService({
    db,
    agent: runs.agentForService(),
    memory,
  });
  const scheduler = new Scheduler({
    db,
    defaultTimezone: "Asia/Shanghai",
    async onDue(schedule) {
      const conversation = db.getConversation(schedule.conversationId);
      if (!conversation)
        throw new Error(`Schedule conversation not found: ${schedule.conversationId}`);
      const channel = channels.get(conversation.channel)?.getState();
      if (!channel?.capabilities.proactiveSend) {
        throw new Error(
          `Channel ${conversation.channel} does not support proactive schedule delivery`,
        );
      }
      const message = db.insertMessage({
        conversationId: conversation.id,
        channelId: conversation.channel,
        accountId: conversation.accountId,
        externalConversationId: conversation.externalId,
        role: "system",
        text: `Scheduled task: ${schedule.name}\n${schedule.prompt}`,
        metadata: { kind: "schedule", scheduleId: schedule.id },
      }).message;
      await runs.admitStoredMessages(conversation.id, schedule.botId, [message.id], "schedule");
    },
  });
  const gateway = new ChannelGateway({ db, channels, owner, runs, discuss });
  gateway.register(new WebChannelAdapter());
  if (configuredOneBot) {
    onebot = new OneBotAdapter(
      {
        wsUrl: config.onebot.wsUrl,
        ...(config.onebot.accessToken ? { accessToken: config.onebot.accessToken } : {}),
        ...(config.onebot.accountId ? { accountId: config.onebot.accountId } : {}),
        requireGroupMention: config.onebot.requireGroupMention,
        privateUserAllowlist: config.onebot.privateUserIds,
        ignoredUserIds: config.onebot.ignoredUserIds,
      },
      async (message) => {
        if (onebot) await gateway.accept(onebot, message);
      },
      (state) => {
        console.log(
          `[finalbot] onebot connected=${state.connected} account=${state.accountId ?? "unknown"}`,
        );
        if (state.connected) void runs.flushOutbox();
      },
    );
    gateway.register(onebot);
  }
  if (config.qq.enabled) {
    const qq: QqOfficialAdapter = new QqOfficialAdapter(
      {
        enabled: config.qq.enabled,
        appId: config.qq.appId,
        appSecret: config.qq.appSecret,
        sessionStore: new SqliteQqSessionStore(db),
        ...(config.qq.tokenUrl ? { tokenUrl: config.qq.tokenUrl } : {}),
        ...(config.qq.apiBaseUrl ? { apiBaseUrl: config.qq.apiBaseUrl } : {}),
        ...(config.qq.gatewayUrl ? { gatewayUrl: config.qq.gatewayUrl } : {}),
      },
      async (message) => gateway.accept(qq, message),
    );
    gateway.register(qq);
  }

  runs.setReplySender(async (address, message) => {
    await channels.send(address, message);
  });
  runs.setReplyChannel(channels);

  await runs.validateWorkspace().catch((error) => {
    console.error(`[finalbot] workspace validation failed: ${String(error)}`);
  });
  await runs.recover();
  discuss.start(async (batch, messageIds) => {
    const conversation = db.getConversation(batch.conversationId);
    if (!conversation) return null;
    db.setConversationActiveBot(batch.conversationId, batch.botId);
    const run = await runs.admitStoredMessages(
      batch.conversationId,
      batch.botId,
      messageIds,
      "discuss",
      `discuss:${batch.id}`,
    );
    return run?.id ?? null;
  });
  await discuss.recover(async (batch, messageIds) => {
    const conversation = db.getConversation(batch.conversationId);
    if (!conversation) return null;
    db.setConversationActiveBot(batch.conversationId, batch.botId);
    const run = await runs.admitStoredMessages(
      batch.conversationId,
      batch.botId,
      messageIds,
      "discuss",
      `discuss:${batch.id}`,
    );
    return run?.id ?? null;
  });
  scheduler.start();
  await channels.start();

  const app = createApp(
    db,
    bus,
    runs,
    () => channels.states(),
    config.repositoryPath,
    config.adminToken,
    owner,
    tools,
    startedAt,
    mcp,
  );
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: 120,
    fetch: app.fetch,
    websocket: {
      open() {},
      message() {},
      close() {},
    },
  });

  console.log(`[finalbot] listening on http://${config.host}:${server.port}`);

  async function shutdown(signal: string): Promise<void> {
    console.log(`[finalbot] ${signal}, shutting down`);
    discuss.stop();
    scheduler.stop();
    clearInterval(cleanupTimer);
    await mcp.close();
    await channels.stop();
    await runs.close();
    db.close();
    server.stop();
    process.exit(0);
  }

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

export function assertAdminBinding(host: string, adminToken: string | null): void {
  if (!isLoopbackHost(host) && !adminToken) {
    throw new Error("FINALBOT_ADMIN_TOKEN is required when listening on a non-loopback address");
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLocaleLowerCase()
    .replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized.startsWith("127.")
  );
}

function toRunSummary(run: ReturnType<FinalBotDatabase["getRun"]> & {}) {
  if (!run) throw new Error("Run is required");
  return {
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
  };
}

function mcpServerSummary(
  server: McpServerRecord,
  snapshot: ToolSnapshot | null,
  policies: ReturnType<FinalBotDatabase["listMcpToolPolicies"]>,
) {
  const args = parseStringArray(server.argsJson);
  const envRefs = parseStringRecord(server.envRefsJson);
  const headers = parseStringRecord(server.headersJson);
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    command: server.command,
    args,
    url: server.url,
    enabled: server.enabled,
    status: server.status,
    lastError: server.lastError,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
    envRefs,
    headers,
    envRefsConfigured: Object.fromEntries(
      Object.entries(envRefs).map(([target, source]) => [
        target,
        process.env[source] !== undefined,
      ]),
    ),
    headersConfigured: Object.fromEntries(
      Object.entries(headers).map(([name, source]) => [name, process.env[source] !== undefined]),
    ),
    tools:
      snapshot?.tools
        .filter((tool) => tool.namespace === `mcp.${server.id}`)
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          policy: tool.policy,
        })) ?? [],
    policies,
  };
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parseStringRecord(value: string): Record<string, string> {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

function webAssetPath(): string | null {
  const candidates = [
    `${import.meta.dir}/../../web/dist`,
    `${import.meta.dir}/../web/dist`,
    `${import.meta.dir}/web`,
    `${process.cwd()}/apps/web/dist`,
    `${process.cwd()}/web`,
  ];
  for (const candidate of candidates) {
    if (Bun.file(`${candidate}/index.html`).size > 0) return candidate;
  }
  return null;
}

function embeddedWebAssets(): Map<string, Blob> {
  const assets = new Map<string, Blob>();
  for (const asset of Bun.embeddedFiles) {
    const name = embeddedFileName(asset).replace(/^dist\//, "");
    assets.set(`/${name}`, asset);
  }
  return assets;
}

function embeddedFileName(asset: Blob): string {
  const name = Reflect.get(asset, "name");
  return typeof name === "string" ? name : "";
}

function parseSequence(value: string | undefined): number | null {
  if (!value) return null;
  const sequence = Number(value);
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
}

function isAuthorized(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice(7));
  const target = Buffer.from(expected);
  return provided.length === target.length && timingSafeEqual(provided, target);
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function webConversationId(db: FinalBotDatabase): string {
  return db.upsertConversation({
    channel: "web",
    accountId: "local",
    externalId: "memory-admin",
    conversationKind: "private",
    title: "Memory administration",
  }).id;
}

function webMemoryAuditRunId(db: FinalBotDatabase): string {
  const conversationId = webConversationId(db);
  const existing = db
    .listRuns(200)
    .find(
      (run) =>
        run.conversationId === conversationId &&
        run.trigger === "web" &&
        run.prompt === "Memory administration",
    );
  if (existing) return existing.id;
  return db.createRun({
    conversationId,
    prompt: "Memory administration",
    requestedBy: "web:local",
    botId: "coder",
    botName: "Coder",
    agent: "codex",
    trigger: "web",
    workspaceMode: "none",
  }).id;
}

if (import.meta.main) {
  void main().catch((error) => {
    console.error(`[finalbot] startup failed: ${String(error)}`);
    process.exit(1);
  });
}
