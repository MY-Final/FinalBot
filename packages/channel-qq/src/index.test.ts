import { afterEach, describe, expect, test } from "bun:test";
import { ChannelRegistry, type InboundEnvelope } from "@finalbot/core";
import { MemoryQqSessionStore, QqOfficialAdapter } from "./index";

const servers: ReturnType<typeof Bun.serve>[] = [];
const adapters: QqOfficialAdapter[] = [];

afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.stop();
  for (const server of servers.splice(0)) server.stop(true);
});

describe("QQ official adapter", () => {
  test("resumes, deduplicates events and sends passive replies with monotonic msg_seq", async () => {
    const messages: InboundEnvelope[] = [];
    const sent: Array<Record<string, unknown>> = [];
    const sessionStore = new MemoryQqSessionStore();
    sessionStore.save("app-1", { sessionId: "session-old", lastSeq: 42 });
    const server = startServer({
      onSend(_path, body) {
        sent.push(body);
        return { id: `sent-${sent.length}` };
      },
      onIdentify(op, payload) {
        const d = payload as { session_id?: string; seq?: number };
        expect(op).toBe(6);
        expect(d.session_id).toBe("session-old");
        expect(d.seq).toBe(42);
      },
    });
    const adapter = new QqOfficialAdapter(
      {
        enabled: true,
        appId: "app-1",
        appSecret: "secret",
        tokenUrl: `http://127.0.0.1:${server.port}/token`,
        apiBaseUrl: `http://127.0.0.1:${server.port}`,
        gatewayUrl: `ws://127.0.0.1:${server.port}/gateway`,
        sessionStore,
      },
      async (message) => {
        messages.push(message);
      },
    );
    adapters.push(adapter);
    await adapter.start();
    await waitFor(() => (messages.length > 0 ? true : null));
    const message = messages[0];
    if (!message) throw new Error("missing inbound message");
    expect(message).toMatchObject({
      channelId: "qq",
      accountId: "app-1",
      externalConversationId: "c2c:user-1",
      conversationKind: "private",
      text: "hello",
    });
    expect(messages).toHaveLength(1);

    await adapter.send(message.replyAddress, {
      text: "first",
      format: "text",
      replyToExternalMessageId: message.externalMessageId,
    });
    await adapter.send(message.replyAddress, {
      text: "second",
      format: "text",
      replyToExternalMessageId: message.externalMessageId,
    });
    expect(sent.map((body) => body.msg_seq)).toEqual([1, 2]);
    const registry = new ChannelRegistry();
    registry.register(adapter, () => undefined);
    const planned = registry.plan(message.replyAddress, {
      text: "x".repeat(12_000),
      format: "text",
      replyToExternalMessageId: message.externalMessageId,
    });
    expect(planned.truncated).toBe(true);
    expect(planned.chunks).toHaveLength(5);
    expect(planned.chunks.at(-1)).toContain("完整结果请在 FinalBot Web 查看");
    await expect(
      adapter.send(
        {
          ...message.replyAddress,
          data: { kind: "c2c", targetId: "user-1" },
        },
        { text: "proactive", format: "text" },
      ),
    ).rejects.toThrow();
  });

  test("maps group OpenIDs and sends a passive group reply", async () => {
    const messages: InboundEnvelope[] = [];
    const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
    const server = startServer({
      event: {
        id: "group-event-1",
        content: "@FinalBot hello",
        timestamp: "2026-10-28T00:00:00Z",
        group_openid: "group-1",
        author: {
          member_openid: "member-1",
          union_openid: "union-1",
        },
      },
      eventType: "GROUP_AT_MESSAGE_CREATE",
      onSend(path, body) {
        sent.push({ path, body });
        return { id: "group-sent-1" };
      },
      onIdentify(op) {
        expect(op).toBe(2);
      },
    });
    const adapter = new QqOfficialAdapter(
      {
        enabled: true,
        appId: "app-1",
        appSecret: "secret",
        tokenUrl: `http://127.0.0.1:${server.port}/token`,
        apiBaseUrl: `http://127.0.0.1:${server.port}`,
        gatewayUrl: `ws://127.0.0.1:${server.port}/gateway`,
      },
      async (message) => {
        messages.push(message);
      },
    );
    adapters.push(adapter);
    await adapter.start();
    const message = await waitFor(() => messages[0] ?? null);

    expect(message).toMatchObject({
      externalConversationId: "group:group-1",
      conversationKind: "group",
      senderId: "member-1",
      senderAliases: ["union-1"],
      botMentioned: true,
    });
    await adapter.send(message.replyAddress, {
      text: "group reply",
      format: "text",
      replyToExternalMessageId: message.externalMessageId,
    });
    expect(sent[0]).toMatchObject({
      path: "/v2/groups/group-1/messages",
      body: {
        msg_id: "group-event-1",
        msg_seq: 1,
        content: "group reply",
      },
    });
  });

  test("refreshes the access token once after a 401 response", async () => {
    const messages: InboundEnvelope[] = [];
    const sent: Array<{ body: Record<string, unknown>; authorization: string | null }> = [];
    let tokenRequests = 0;
    const server = startServer({
      tokens: ["token-1", "token-2"],
      unauthorizedFor: "token-1",
      onToken() {
        tokenRequests += 1;
      },
      onSend(_path, body, authorization) {
        sent.push({ body, authorization });
        return { id: "refreshed" };
      },
      onIdentify(op) {
        expect(op).toBe(2);
      },
    });
    const adapter = new QqOfficialAdapter(
      {
        enabled: true,
        appId: "app-refresh",
        appSecret: "secret",
        tokenUrl: `http://127.0.0.1:${server.port}/token`,
        apiBaseUrl: `http://127.0.0.1:${server.port}`,
        gatewayUrl: `ws://127.0.0.1:${server.port}/gateway`,
      },
      async (message) => {
        messages.push(message);
      },
    );
    adapters.push(adapter);
    await adapter.start();
    const message = await waitFor(() => messages[0] ?? null);
    await adapter.send(message.replyAddress, {
      text: "after refresh",
      format: "text",
      replyToExternalMessageId: message.externalMessageId,
    });

    expect(tokenRequests).toBe(2);
    expect(sent).toEqual([
      {
        body: expect.objectContaining({ msg_seq: 1, content: "after refresh" }),
        authorization: "QQBot token-2",
      },
    ]);
  });

  test("resumes the saved session after the gateway disconnects", async () => {
    const messages: InboundEnvelope[] = [];
    const connectionOps: number[] = [];
    const server = startServer({
      closeAfterIdentify: true,
      onSend() {
        return { id: "sent" };
      },
      onIdentify(op) {
        connectionOps.push(op);
      },
    });
    const adapter = new QqOfficialAdapter(
      {
        enabled: true,
        appId: "app-reconnect",
        appSecret: "secret",
        tokenUrl: `http://127.0.0.1:${server.port}/token`,
        apiBaseUrl: `http://127.0.0.1:${server.port}`,
        gatewayUrl: `ws://127.0.0.1:${server.port}/gateway`,
        sessionStore: new MemoryQqSessionStore(),
      },
      async (message) => {
        messages.push(message);
      },
    );
    adapters.push(adapter);
    await adapter.start();
    await waitFor(() => (connectionOps.length >= 2 ? true : null), 5_000);

    expect(connectionOps).toEqual([2, 6]);
    expect(messages).toHaveLength(1);
  });
});

interface MockOptions {
  onSend(path: string, body: Record<string, unknown>, authorization: string | null): unknown;
  onIdentify(op: number, payload: unknown): void;
  onToken?(): void;
  tokens?: string[];
  unauthorizedFor?: string;
  event?: Record<string, unknown>;
  eventType?: string;
  closeAfterIdentify?: boolean;
}

function startServer(options: MockOptions): ReturnType<typeof Bun.serve> {
  let socket: { send(data: string): unknown } | null = null;
  let tokenIndex = 0;
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request: Request, bunServer: ReturnType<typeof Bun.serve>): Response | undefined {
      const url = new URL(request.url);
      if (url.pathname === "/gateway" && bunServer.upgrade(request, { data: undefined })) {
        return undefined;
      }
      if (url.pathname === "/token") {
        options.onToken?.();
        const tokens = options.tokens ?? ["token-1"];
        const token = tokens[Math.min(tokenIndex, tokens.length - 1)] ?? "token-1";
        tokenIndex += 1;
        return Response.json({ access_token: token, expires_in: 7200 });
      }
      if (url.pathname === "/gateway") {
        return Response.json({ url: `ws://127.0.0.1:${server.port}/gateway` });
      }
      if (url.pathname.endsWith("/messages")) {
        if (
          options.unauthorizedFor &&
          request.headers.get("Authorization") === `QQBot ${options.unauthorizedFor}`
        ) {
          return new Response("expired", { status: 401 });
        }
        return request
          .json()
          .then((body) =>
            Response.json(
              options.onSend(
                url.pathname,
                body as Record<string, unknown>,
                request.headers.get("Authorization"),
              ),
            ),
          ) as unknown as Response;
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        socket = ws;
        ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 30_000 } }));
      },
      message(ws, raw) {
        const value = JSON.parse(String(raw)) as { op: number; d: unknown };
        if (value.op !== 2 && value.op !== 6) return;
        options.onIdentify(value.op, value.d);
        if (value.op === 2 || value.op === 6) {
          socket?.send(
            JSON.stringify({
              op: 0,
              s: 43,
              t: value.op === 6 ? "RESUMED" : "READY",
              d: value.op === 6 ? {} : { session_id: "session-new" },
            }),
          );
          const event = options.event
            ? {
                id: "event-1",
                op: 0,
                s: 44,
                t: options.eventType ?? "C2C_MESSAGE_CREATE",
                d: options.event,
              }
            : {
                id: "event-1",
                op: 0,
                s: 44,
                t: "C2C_MESSAGE_CREATE",
                d: {
                  id: "message-1",
                  content: "hello",
                  timestamp: "2026-10-28T00:00:00Z",
                  author: { user_openid: "user-1" },
                },
              };
          socket?.send(JSON.stringify(event));
          socket?.send(JSON.stringify(event));
          if (options.closeAfterIdentify) {
            setTimeout(() => ws.close(), 20);
          }
        }
      },
      close() {
        socket = null;
      },
    },
  });
  servers.push(server);
  return server;
}

async function waitFor<T>(read: () => T | null, timeoutMs = 3_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = read();
    if (value) return value;
    await Bun.sleep(20);
  }
  throw new Error("Timed out");
}
