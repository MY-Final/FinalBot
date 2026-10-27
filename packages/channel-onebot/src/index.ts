import type { InboundMessage } from "@finalbot/core";
import { z } from "zod";

const segmentSchema = z
  .object({
    type: z.string(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const eventSchema = z
  .object({
    post_type: z.string(),
    message_type: z.enum(["private", "group"]).optional(),
    self_id: z.union([z.string(), z.number()]).optional(),
    user_id: z.union([z.string(), z.number()]).optional(),
    group_id: z.union([z.string(), z.number()]).optional(),
    message_id: z.union([z.string(), z.number()]).optional(),
    raw_message: z.string().optional(),
    message: z.union([z.string(), z.array(segmentSchema)]).optional(),
    sender: z.object({ nickname: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

export type OneBotEvent = z.infer<typeof eventSchema>;

export interface OneBotConfig {
  wsUrl: string;
  accessToken?: string;
  accountId?: string;
}

export interface OneBotConnectionState {
  configured: boolean;
  connected: boolean;
  accountId: string | null;
}

type MessageHandler = (message: InboundMessage) => void | Promise<void>;
type StateHandler = (state: OneBotConnectionState) => void;

export interface OneBotActionResponse {
  status?: string;
  retcode?: number;
  data?: unknown;
  wording?: string;
}

interface PendingAction {
  resolve: (value: OneBotActionResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class OneBotAdapter {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = 1000;
  private stopped = false;
  private actionSequence = 1;
  private readonly pending = new Map<string, PendingAction>();
  private state: OneBotConnectionState;

  constructor(
    private readonly config: OneBotConfig,
    private readonly onMessage: MessageHandler,
    private readonly onState: StateHandler,
  ) {
    this.state = {
      configured: config.wsUrl.length > 0,
      connected: false,
      accountId: config.accountId ?? null,
    };
  }

  getState(): OneBotConnectionState {
    return { ...this.state };
  }

  start(): void {
    if (!this.config.wsUrl) {
      this.onState(this.getState());
      return;
    }
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
    this.state = { ...this.state, connected: false };
    this.onState(this.getState());
  }

  private connect(): void {
    const headers: Record<string, string> = {};
    if (this.config.accessToken) {
      headers.Authorization = `Bearer ${this.config.accessToken}`;
    }
    const socket = new WebSocket(this.config.wsUrl, {
      headers,
    } as unknown as string[]);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.reconnectDelayMs = 1000;
      this.state = { ...this.state, connected: true };
      this.onState(this.getState());
    });
    socket.addEventListener("message", (event) => {
      void this.handleMessage(event.data);
    });
    socket.addEventListener("close", () => {
      this.state = { ...this.state, connected: false };
      this.onState(this.getState());
      if (!this.stopped) this.scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      // The close handler owns reconnect behavior.
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelayMs);
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
  }

  private async handleMessage(data: unknown): Promise<void> {
    const text =
      typeof data === "string"
        ? data
        : data instanceof Blob
          ? await data.text()
          : data instanceof ArrayBuffer
            ? new TextDecoder().decode(data)
            : "";
    if (!text) return;

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return;
    }

    if (this.isActionResponse(value)) {
      this.settleAction(value);
      return;
    }

    const parsed = eventSchema.safeParse(value);
    if (!parsed.success) return;
    const message = this.toInbound(parsed.data);
    if (message) await this.onMessage(message);
  }

  private isActionResponse(value: unknown): value is OneBotActionResponse & { echo: string } {
    return (
      typeof value === "object" &&
      value !== null &&
      "echo" in value &&
      typeof (value as { echo?: unknown }).echo === "string"
    );
  }

  private settleAction(response: OneBotActionResponse & { echo: string }): void {
    const pending = this.pending.get(response.echo);
    if (!pending) return;
    this.pending.delete(response.echo);
    clearTimeout(pending.timer);
    pending.resolve(response);
  }

  private toInbound(event: OneBotEvent): InboundMessage | null {
    if (event.post_type !== "message" || !event.message_type) return null;
    if (event.self_id !== undefined) {
      this.state = {
        ...this.state,
        accountId: String(event.self_id),
      };
    }
    const text = extractText(event.message, event.raw_message);
    if (!text.trim()) return null;

    const messageId = String(event.message_id ?? crypto.randomUUID());
    const senderId = String(event.user_id ?? "unknown");
    const accountId = String(event.self_id ?? this.config.accountId ?? "unknown");
    const externalConversationId =
      event.message_type === "group"
        ? `group:${String(event.group_id ?? "unknown")}`
        : `private:${senderId}`;

    return {
      channel: "onebot",
      accountId,
      externalConversationId,
      conversationKind: event.message_type,
      externalMessageId: messageId,
      senderId,
      text,
      raw: event,
      receivedAt: new Date().toISOString(),
      replyTarget:
        event.message_type === "group"
          ? {
              kind: "onebot",
              messageType: "group",
              groupId: String(event.group_id ?? "unknown"),
            }
          : {
              kind: "onebot",
              messageType: "private",
              userId: senderId,
            },
    };
  }

  async sendPrivate(userId: string, text: string): Promise<void> {
    await this.callAction("send_private_msg", { user_id: userId, message: text });
  }

  async sendGroup(groupId: string, text: string): Promise<void> {
    await this.callAction("send_group_msg", { group_id: groupId, message: text });
  }

  async callAction(action: string, params: Record<string, unknown>): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("OneBot WebSocket is not connected");
    }
    const echo = `finalbot-${this.actionSequence++}`;
    const response = await new Promise<OneBotActionResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot action timed out: ${action}`));
      }, 15_000);
      this.pending.set(echo, { resolve, reject, timer });
      socket.send(JSON.stringify({ action, params, echo }));
    });
    if (response.retcode !== undefined && response.retcode !== 0) {
      throw new Error(response.wording ?? `OneBot action failed: ${action}`);
    }
    return response.data;
  }
}

export function extractText(
  message:
    | string
    | Array<{ type: string; data?: Record<string, unknown> | undefined }>
    | undefined,
  rawMessage?: string,
): string {
  if (typeof message === "string") return message;
  if (!Array.isArray(message)) return rawMessage ?? "";

  const parts: string[] = [];
  for (const segment of message) {
    if (segment.type === "text") {
      const text = segment.data?.text;
      if (typeof text === "string") parts.push(text);
    } else if (segment.type === "at") {
      const qq = segment.data?.qq;
      if (qq !== undefined) parts.push(`@${String(qq)}`);
    } else if (segment.type === "image") {
      parts.push("[图片]");
    } else if (segment.type === "file") {
      parts.push("[文件]");
    }
  }
  return parts.join("");
}

