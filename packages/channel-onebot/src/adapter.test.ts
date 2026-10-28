import { afterEach, describe, expect, test } from "bun:test";
import type { InboundEnvelope } from "@finalbot/core";
import { OneBotAdapter, type OneBotConnectionState } from "./index";

const servers: ReturnType<typeof Bun.serve>[] = [];
const adapters: OneBotAdapter[] = [];

afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.stop();
  for (const server of servers.splice(0)) server.stop(true);
});

describe("OneBot WebSocket adapter", () => {
  test("receives binary message events and correlates action responses", async () => {
    const received: InboundEnvelope[] = [];
    const actions: Array<{ action: string; params: Record<string, unknown> }> = [];
    const states: OneBotConnectionState[] = [];
    const server = startServer((socket, raw) => {
      const request = JSON.parse(raw) as {
        action: string;
        params: Record<string, unknown>;
        echo: string;
      };
      actions.push({ action: request.action, params: request.params });
      socket.send(JSON.stringify({ status: "ok", retcode: 0, data: {}, echo: request.echo }));
    });

    const adapter = new OneBotAdapter(
      {
        wsUrl: `ws://127.0.0.1:${server.port}`,
        accountId: "479284441",
        privateUserAllowlist: ["10001"],
      },
      async (message) => {
        received.push(message);
      },
      (state) => {
        states.push(state);
      },
    );
    adapters.push(adapter);
    adapter.start();
    await waitFor(() => states.some((state) => state.connected));

    const event = JSON.stringify({
      post_type: "message",
      message_type: "private",
      self_id: 479284441,
      user_id: 10001,
      message_id: 90001,
      raw_message: "/help",
      message: [{ type: "text", data: { text: "/help" } }],
    });
    server.publish("test-messages", new TextEncoder().encode(event));

    const message = await waitFor(() => received[0] ?? null);
    expect(message.channelId).toBe("onebot");
    expect(message.externalConversationId).toBe("private:10001");
    expect(message.senderId).toBe("10001");
    expect(message.text).toBe("/help");

    await adapter.sendPrivate("10001", "pong");
    expect(actions).toEqual([
      {
        action: "send_private_msg",
        params: { user_id: "10001", message: "pong" },
      },
    ]);
  });
});

function startServer(onMessage: (socket: { send(data: string): unknown }, raw: string) => void) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, bunServer) {
      if (bunServer.upgrade(request)) return;
      return new Response("websocket upgrade required", { status: 400 });
    },
    websocket: {
      open(socket) {
        socket.subscribe("test-messages");
      },
      message(socket, raw) {
        onMessage(socket, typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
      },
    },
  });
  servers.push(server);
  return server;
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
