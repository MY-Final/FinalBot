import { mkdir } from "node:fs/promises";
import { OneBotAdapter } from "@finalbot/channel-onebot";
import { nowIso } from "@finalbot/core";
import { FinalBotDatabase } from "@finalbot/db";
import type { HealthResponse, ServerEvent } from "@finalbot/protocol";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { z } from "zod";
import { loadConfig } from "./config";
import { EventBus } from "./event-bus";
import { RunService } from "./run-service";

export function createApp(
  db: FinalBotDatabase,
  bus: EventBus,
  runs: RunService,
  onebotState: () => { configured: boolean; connected: boolean; accountId: string | null },
  repositoryPath: string | null,
  startedAt = Date.now(),
): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    await next();
  });

  app.get("/api/health", (c) => {
    const state = onebotState();
    const response: HealthResponse = {
      ok: true,
      version: "0.1.0",
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      onebot: {
        configured: state.configured,
        connected: state.connected,
        accountId: state.accountId,
      },
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
      phases: db.listPhases(run.id),
    });
  });

  const createRunSchema = z.object({
    prompt: z.string().trim().min(1).max(50_000),
  });

  app.post("/api/runs", async (c) => {
    const parsed = createRunSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", message: parsed.error.message }, 400);
    }
    try {
      const run = await runs.createWebRun(parsed.data.prompt);
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
  await mkdir(config.dataDir, { recursive: true });

  const db = new FinalBotDatabase(config.databasePath);
  const bus = new EventBus();
  const runs = new RunService(db, bus, config);
  const startedAt = Date.now();

  const onebot = new OneBotAdapter(
    {
      wsUrl: config.onebot.wsUrl,
      ...(config.onebot.accessToken ? { accessToken: config.onebot.accessToken } : {}),
      ...(config.onebot.accountId ? { accountId: config.onebot.accountId } : {}),
      requireGroupMention: config.onebot.requireGroupMention,
      privateUserAllowlist: config.onebot.privateUserIds,
      ignoredUserIds: config.onebot.ignoredUserIds,
    },
    async (message) => {
      await runs.admitInbound(message);
    },
    (state) => {
      console.log(
        `[finalbot] onebot connected=${state.connected} account=${state.accountId ?? "unknown"}`,
      );
      if (state.connected) void runs.flushOutbox();
    },
  );

  runs.setReplySender(async (target, text) => {
    if (target.kind !== "onebot") return;
    if (target.messageType === "group" && typeof target.groupId === "string") {
      await onebot.sendGroup(target.groupId, text);
    } else if (target.messageType === "private" && typeof target.userId === "string") {
      await onebot.sendPrivate(target.userId, text);
    }
  });

  await runs.validateWorkspace().catch((error) => {
    console.error(`[finalbot] workspace validation failed: ${String(error)}`);
  });
  await runs.recover();
  onebot.start();

  const app = createApp(db, bus, runs, () => onebot.getState(), config.repositoryPath, startedAt);
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
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
    onebot.stop();
    await runs.close();
    db.close();
    server.stop();
    process.exit(0);
  }

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

function toRunSummary(run: ReturnType<FinalBotDatabase["getRun"]> & {}) {
  if (!run) throw new Error("Run is required");
  return {
    id: run.id,
    state: run.state,
    prompt: run.prompt,
    requestedBy: run.requestedBy,
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
  };
}

function webAssetPath(): string | null {
  const candidates = [
    `${import.meta.dir}/../../web/dist`,
    `${import.meta.dir}/../web/dist`,
    `${import.meta.dir}/web`,
    `${process.cwd()}/apps/web/dist`,
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

if (import.meta.main) {
  void main().catch((error) => {
    console.error(`[finalbot] startup failed: ${String(error)}`);
    process.exit(1);
  });
}
