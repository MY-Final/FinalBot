import type {
  ChannelAdapter,
  ChannelState,
  InboundEnvelope,
  OutboundAddress,
  OutboundMessage,
  SendResult,
} from "@finalbot/core";
import { z } from "zod";

export interface QqOfficialConfig {
  enabled: boolean;
  appId: string;
  appSecret: string;
  tokenUrl?: string;
  apiBaseUrl?: string;
  gatewayUrl?: string;
  sessionStore?: QqSessionStore;
}

export interface QqSession {
  sessionId: string;
  lastSeq: number;
}

export interface QqSessionStore {
  load(accountId: string): QqSession | null;
  save(accountId: string, session: QqSession): void;
  clear(accountId: string): void;
}

type InboundHandler = (message: InboundEnvelope) => void | Promise<void>;

const gatewayEventSchema = z
  .object({
    op: z.number().int(),
    d: z.unknown().optional(),
    s: z.number().int().optional(),
    t: z.string().optional(),
  })
  .passthrough();

const c2cEventSchema = z
  .object({
    id: z.string(),
    content: z.string().default(""),
    timestamp: z.string().optional(),
    author: z.object({
      id: z.string().optional(),
      user_openid: z.string().optional(),
      union_openid: z.string().optional(),
    }),
    message_reference: z.object({ message_id: z.string().optional() }).optional(),
  })
  .passthrough();

const groupEventSchema = z
  .object({
    id: z.string(),
    content: z.string().default(""),
    timestamp: z.string().optional(),
    group_id: z.string().optional(),
    group_openid: z.string(),
    author: z.object({
      id: z.string().optional(),
      member_openid: z.string().optional(),
      union_openid: z.string().optional(),
    }),
    message_reference: z.object({ message_id: z.string().optional() }).optional(),
  })
  .passthrough();

interface PendingHello {
  heartbeatIntervalMs: number;
}

const INTENTS_GROUP_AND_C2C = 1 << 25;

export class QqOfficialAdapter implements ChannelAdapter {
  readonly id = "qq";
  private socket: WebSocket | null = null;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private lastSeq = 0;
  private sessionId = "";
  private connected = false;
  private lastError: string | null = null;
  private token: { value: string; expiresAt: number } | null = null;
  private readonly seen = new Set<string>();
  private readonly msgSeq = new Map<string, number>();
  private readonly passiveWindows = new Map<string, number>();

  constructor(
    private readonly config: QqOfficialConfig,
    private readonly onMessage: InboundHandler,
    private readonly onState?: (state: ChannelState) => void,
  ) {
    const saved = config.sessionStore?.load(config.appId);
    if (saved) {
      this.sessionId = saved.sessionId;
      this.lastSeq = saved.lastSeq;
    }
  }

  getState(): ChannelState {
    return {
      id: this.id,
      type: "qq",
      enabled: this.config.enabled,
      configured:
        this.config.enabled && this.config.appId.length > 0 && this.config.appSecret.length > 0,
      connected: this.connected,
      accountId: this.config.appId || null,
      capabilities: {
        observeAll: false,
        proactiveSend: false,
        reply: true,
        markdown: true,
        maxTextLength: 2_000,
        maxRepliesPerInbound: 5,
      },
      lastError: this.lastError,
    };
  }

  async start(): Promise<void> {
    if (!this.getState().configured || this.stopped) return;
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    socket?.close();
    this.publishState();
  }

  async send(address: OutboundAddress, message: OutboundMessage): Promise<SendResult> {
    if (address.channelId !== this.id) throw new Error(`Unsupported channel: ${address.channelId}`);
    const kind = address.data.kind;
    const targetId = address.data.targetId;
    const replyTo =
      message.replyToExternalMessageId ??
      (typeof address.data.replyToExternalMessageId === "string"
        ? address.data.replyToExternalMessageId
        : null);
    if ((kind !== "c2c" && kind !== "group") || typeof targetId !== "string" || !targetId) {
      throw new Error("QQ official only supports passive replies with msg_id");
    }
    if (!replyTo) {
      throw new Error("QQ official passive reply requires msg_id");
    }
    const receivedAt = this.passiveWindows.get(replyTo) ?? null;
    if (receivedAt !== null && Date.now() - receivedAt > 5 * 60_000) {
      throw new Error("QQ official passive reply window has expired");
    }
    const sequence = (this.msgSeq.get(replyTo) ?? 0) + 1;
    this.msgSeq.set(replyTo, sequence);
    const path =
      kind === "c2c"
        ? `/v2/users/${encodeURIComponent(targetId)}/messages`
        : `/v2/groups/${encodeURIComponent(targetId)}/messages`;
    const payload =
      message.format === "markdown"
        ? {
            msg_type: 2,
            markdown: { content: message.text },
            msg_id: replyTo,
            msg_seq: sequence,
          }
        : {
            msg_type: 0,
            content: message.text,
            msg_id: replyTo,
            msg_seq: sequence,
          };
    const response = await this.request<{ id?: string }>("POST", path, payload);
    return {
      ...(response?.id ? { externalMessageId: response.id } : {}),
      deliveredAt: new Date().toISOString(),
    };
  }

  private async connect(): Promise<void> {
    try {
      if (!this.config.gatewayUrl) {
        const result = await this.request<{ url?: string }>("GET", "/gateway");
        if (!result.url) throw new Error("QQ gateway response missing url");
        this.config.gatewayUrl = result.url;
      }
      const socket = new WebSocket(this.config.gatewayUrl);
      this.socket = socket;
      socket.addEventListener("message", (event) => void this.handleGatewayMessage(event.data));
      socket.addEventListener("close", (event) => {
        this.connected = false;
        this.publishState();
        if (!this.stopped) this.scheduleReconnect(event.code);
      });
      socket.addEventListener("error", () => {
        this.lastError = "QQ gateway WebSocket error";
        this.publishState();
      });
    } catch (error) {
      this.lastError = errorMessage(error);
      this.publishState();
      if (!this.stopped) this.scheduleReconnect(0);
    }
  }

  private async handleGatewayMessage(data: unknown): Promise<void> {
    const text = await websocketText(data);
    if (!text) return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      return;
    }
    const parsed = gatewayEventSchema.safeParse(decoded);
    if (!parsed.success) return;
    const frame = parsed.data;
    if (frame.s !== undefined) this.persistSession(this.sessionId, frame.s);
    if (frame.op === 10) {
      const hello = frame.d as PendingHello | undefined;
      this.startHeartbeat(hello?.heartbeatIntervalMs ?? 30_000);
      await this.identifyOrResume();
      return;
    }
    if (frame.op === 11) return;
    if (frame.op === 7) {
      this.reconnect("QQ gateway asked to reconnect");
      return;
    }
    if (frame.op === 9) {
      this.clearSession();
      this.reconnect("QQ gateway invalid session");
      return;
    }
    if (frame.op !== 0 || !frame.t) return;

    if (frame.t === "READY") {
      const ready = frame.d as { session_id?: string } | undefined;
      this.sessionId = ready?.session_id ?? "";
      this.connected = true;
      this.lastError = null;
      this.reconnectAttempt = 0;
      this.persistSession(this.sessionId, this.lastSeq);
      this.publishState();
      return;
    }
    if (frame.t === "RESUMED") {
      this.connected = true;
      this.lastError = null;
      this.publishState();
      return;
    }
    if (frame.t === "C2C_MESSAGE_CREATE" || frame.t === "GROUP_AT_MESSAGE_CREATE") {
      await this.handleMessageEvent(frame.t, frame.d);
    }
  }

  private async identifyOrResume(): Promise<void> {
    const token = await this.accessToken();
    if (!this.socket) return;
    if (this.sessionId && this.lastSeq > 0) {
      this.socket.send(
        JSON.stringify({
          op: 6,
          d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.lastSeq },
        }),
      );
      return;
    }
    this.socket.send(
      JSON.stringify({
        op: 2,
        d: { token: `QQBot ${token}`, intents: INTENTS_GROUP_AND_C2C, shard: [0, 1] },
      }),
    );
  }

  private async handleMessageEvent(type: string, raw: unknown): Promise<void> {
    const message =
      type === "C2C_MESSAGE_CREATE"
        ? this.parseC2c(raw)
        : type === "GROUP_AT_MESSAGE_CREATE"
          ? this.parseGroup(raw)
          : null;
    if (!message) return;
    if (this.seen.has(message.externalMessageId)) return;
    this.seen.add(message.externalMessageId);
    if (this.seen.size > 2_000) {
      const oldest = this.seen.values().next().value;
      if (oldest) this.seen.delete(oldest);
    }
    this.passiveWindows.set(message.externalMessageId, Date.now());
    if (this.passiveWindows.size > 2_000) {
      const oldest = this.passiveWindows.keys().next().value;
      if (oldest) this.passiveWindows.delete(oldest);
    }
    await this.onMessage(message);
  }

  private parseC2c(raw: unknown): InboundEnvelope | null {
    const parsed = c2cEventSchema.safeParse(raw);
    if (!parsed.success) return null;
    const value = parsed.data;
    const senderId = value.author.user_openid ?? value.author.id;
    if (!senderId || !value.id) return null;
    const aliases = value.author.union_openid ? [value.author.union_openid] : [];
    return {
      channelId: this.id,
      accountId: this.config.appId,
      externalConversationId: `c2c:${senderId}`,
      conversationKind: "private",
      externalMessageId: value.id,
      senderId,
      ...(aliases.length > 0 ? { senderAliases: aliases } : {}),
      text: value.content,
      mentions: [],
      botMentioned: false,
      botRepliedTo: Boolean(value.message_reference?.message_id),
      ...(value.message_reference?.message_id
        ? { replyToExternalMessageId: value.message_reference.message_id }
        : {}),
      receivedAt: parseTimestamp(value.timestamp),
      replyAddress: {
        channelId: this.id,
        accountId: this.config.appId,
        data: { kind: "c2c", targetId: senderId, replyToExternalMessageId: value.id },
      },
      raw: value,
    };
  }

  private parseGroup(raw: unknown): InboundEnvelope | null {
    const parsed = groupEventSchema.safeParse(raw);
    if (!parsed.success) return null;
    const value = parsed.data;
    const senderId = value.author.member_openid ?? value.author.id;
    if (!senderId || !value.id || !value.group_openid) return null;
    const aliases = value.author.union_openid ? [value.author.union_openid] : [];
    return {
      channelId: this.id,
      accountId: this.config.appId,
      externalConversationId: `group:${value.group_openid}`,
      conversationKind: "group",
      externalMessageId: value.id,
      senderId,
      ...(aliases.length > 0 ? { senderAliases: aliases } : {}),
      text: value.content,
      mentions: [],
      botMentioned: true,
      botRepliedTo: Boolean(value.message_reference?.message_id),
      ...(value.message_reference?.message_id
        ? { replyToExternalMessageId: value.message_reference.message_id }
        : {}),
      receivedAt: parseTimestamp(value.timestamp),
      replyAddress: {
        channelId: this.id,
        accountId: this.config.appId,
        data: {
          kind: "group",
          targetId: value.group_openid,
          replyToExternalMessageId: value.id,
        },
      },
      raw: value,
    };
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 300_000) return this.token.value;
    const tokenUrl = this.config.tokenUrl ?? "https://bots.qq.com/app/getAppAccessToken";
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: this.config.appId, clientSecret: this.config.appSecret }),
    });
    if (!response.ok) {
      throw new Error(`QQ token request failed: ${response.status}`);
    }
    const body = (await response.json()) as {
      access_token?: string;
      expires_in?: number | string;
    };
    if (!body.access_token) throw new Error("QQ token response missing access_token");
    const expiresIn = Number(body.expires_in ?? 7200);
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 7200) * 1000,
    };
    return this.token.value;
  }

  private async request<T>(
    method: string,
    path: string,
    payload?: unknown,
    retry = true,
  ): Promise<T> {
    const token = await this.accessToken();
    const base = this.config.apiBaseUrl ?? "https://api.sgroup.qq.com";
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `QQBot ${token}`,
        "Content-Type": "application/json",
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    if (response.status === 401 && retry) {
      this.token = null;
      return this.request<T>(method, path, payload, false);
    }
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`QQ API ${method} ${path} failed: ${response.status} ${body.slice(0, 500)}`);
    }
    if (response.status === 204) return {} as T;
    return (await response.json()) as T;
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(
      () => {
        if (this.socket?.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify({ op: 1, d: this.lastSeq }));
        }
      },
      Math.max(1_000, intervalMs),
    );
    this.heartbeatTimer.unref?.();
  }

  private reconnect(reason: string): void {
    this.lastError = reason;
    this.connected = false;
    this.publishState();
    this.socket?.close();
  }

  private scheduleReconnect(closeCode: number): void {
    if (this.reconnectTimer) return;
    if (closeCode === 4006 || closeCode === 4007 || closeCode === 4009) {
      this.clearSession();
    }
    if (closeCode === 4004) this.token = null;
    const delays = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 300_000];
    const delay = delays[Math.min(this.reconnectAttempt, delays.length - 1)] ?? 300_000;
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
  }

  private persistSession(sessionId: string, lastSeq: number): void {
    this.lastSeq = lastSeq;
    this.sessionId = sessionId || this.sessionId;
    this.config.sessionStore?.save(this.config.appId, {
      sessionId: this.sessionId,
      lastSeq: this.lastSeq,
    });
  }

  private clearSession(): void {
    this.sessionId = "";
    this.lastSeq = 0;
    this.config.sessionStore?.clear(this.config.appId);
  }

  private publishState(): void {
    this.onState?.(this.getState());
  }
}

export class MemoryQqSessionStore implements QqSessionStore {
  private readonly sessions = new Map<string, QqSession>();

  load(accountId: string): QqSession | null {
    return this.sessions.get(accountId) ?? null;
  }

  save(accountId: string, session: QqSession): void {
    this.sessions.set(accountId, session);
  }

  clear(accountId: string): void {
    this.sessions.delete(accountId);
  }
}

function parseTimestamp(value: string | undefined): string {
  if (!value) return new Date().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function websocketText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return "";
}
