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

const config = loadConfig();
await mkdir(config.dataDir, { recursive: true });

const db = new FinalBotDatabase(config.databasePath);
const bus = new EventBus();
const runs = new RunService(db, bus, config);
const startedAt = Date.now();

await runs.validateWorkspace().catch((error) => {
  console.error(`[finalbot] workspace validation failed: ${String(error)}`);
});
await runs.recover();

const onebot = new OneBotAdapter(
  {
    wsUrl: config.onebot.wsUrl,
    ...(config.onebot.accessToken ? { accessToken: config.onebot.accessToken } : {}),
    ...(config.onebot.accountId ? { accountId: config.onebot.accountId } : {}),
  },
  async (message) => {
    await runs.admitInbound(message);
  },
  (state) => {
    console.log(
      `[finalbot] onebot connected=${state.connected} account=${state.accountId ?? "unknown"}`,
    );
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
onebot.start();

const app = new Hono();

app.use("*", async (c, next) => {
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  await next();
});

app.get("/api/health", (c) => {
  const onebotState = onebot.getState();
  const response: HealthResponse = {
    ok: true,
    version: "0.1.0",
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    onebot: {
      configured: onebotState.configured,
      connected: onebotState.connected,
      accountId: onebotState.accountId,
    },
    repository: {
      configured: config.repositoryPath !== null,
      path: config.repositoryPath,
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
  return c.body(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (event: ServerEvent) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        };
        send({
          type: "system",
          level: "info",
          message: "connected",
          at: nowIso(),
        });
        const unsubscribe = bus.subscribe(send);
        const heartbeat = setInterval(() => {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        }, 15_000);
        c.req.raw.signal.addEventListener("abort", () => {
          clearInterval(heartbeat);
          unsubscribe();
          controller.close();
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

function toRunSummary(run: ReturnType<FinalBotDatabase["getRun"]> & {}) {
  if (!run) throw new Error("Run is required");
  return {
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

async function shutdown(signal: string): Promise<void> {
  console.log(`[finalbot] ${signal}, shutting down`);
  onebot.stop();
  await runs.close();
  db.close();
  server.stop();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
