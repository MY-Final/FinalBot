import type {
  ChannelAdapter,
  ChannelState,
  InboundEnvelope,
  OutboundAddress,
  OutboundMessage,
  SendResult,
} from "./contracts";

export type InboundHandler = (message: InboundEnvelope) => void | Promise<void>;

export interface OutboundPlan {
  chunks: string[];
  truncated: boolean;
}

export interface SendChunk {
  index: number;
  text: string;
}

export class ChannelRegistry {
  private readonly adapters = new Map<string, ChannelAdapter>();
  private readonly inbound = new Map<string, InboundHandler>();

  register(adapter: ChannelAdapter, handler: InboundHandler): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Channel already registered: ${adapter.id}`);
    }
    this.adapters.set(adapter.id, adapter);
    this.inbound.set(adapter.id, handler);
  }

  get(id: string): ChannelAdapter | null {
    return this.adapters.get(id) ?? null;
  }

  list(): ChannelAdapter[] {
    return [...this.adapters.values()];
  }

  states(): ChannelState[] {
    return this.list().map((adapter) => adapter.getState());
  }

  async start(): Promise<void> {
    for (const adapter of this.adapters.values()) await adapter.start();
  }

  async stop(): Promise<void> {
    await Promise.all(this.list().map((adapter) => adapter.stop()));
  }

  async send(address: OutboundAddress, message: OutboundMessage): Promise<SendResult> {
    const adapter = this.adapters.get(address.channelId);
    if (!adapter) throw new Error(`Unknown channel: ${address.channelId}`);
    const { chunks } = this.plan(address, message);
    const sent = await this.sendChunks(
      address,
      message,
      chunks.map((text, index) => ({ index, text })),
    );
    const last = sent.at(-1);
    if (!last) throw new Error(`Channel produced no chunks: ${address.channelId}`);
    return last;
  }

  async sendChunks(
    address: OutboundAddress,
    message: OutboundMessage,
    chunks: SendChunk[],
  ): Promise<SendResult[]> {
    const adapter = this.adapters.get(address.channelId);
    if (!adapter) throw new Error(`Unknown channel: ${address.channelId}`);
    const results: SendResult[] = [];
    for (const chunk of chunks) {
      results.push(
        await adapter.send(address, {
          ...message,
          text: chunk.text,
          ...(message.replyToExternalMessageId
            ? { replyToExternalMessageId: message.replyToExternalMessageId }
            : {}),
        }),
      );
    }
    return results;
  }

  plan(address: OutboundAddress, message: OutboundMessage): OutboundPlan {
    const adapter = this.adapters.get(address.channelId);
    if (!adapter) throw new Error(`Unknown channel: ${address.channelId}`);
    const capabilities = adapter.getState().capabilities;
    const chunks = splitText(message.text, capabilities.maxTextLength);
    const maxReplies = capabilities.maxRepliesPerInbound;
    if (message.replyToExternalMessageId && maxReplies === 1 && chunks.length > 1) {
      const marker = "内容过长，完整结果请在 FinalBot Web 查看。";
      const full = chunks.join("\n");
      const room = Math.max(0, capabilities.maxTextLength - marker.length - 2);
      return {
        chunks: [`${full.slice(0, room).trimEnd()}\n\n${marker}`],
        truncated: true,
      };
    }
    if (!maxReplies || chunks.length <= maxReplies) {
      return { chunks, truncated: false };
    }
    const kept = chunks.slice(0, Math.max(1, maxReplies));
    const marker = "内容过长，完整结果请在 FinalBot Web 查看。";
    const lastIndex = kept.length - 1;
    const last = kept[lastIndex] ?? "";
    const room = Math.max(0, capabilities.maxTextLength - marker.length - 2);
    kept[lastIndex] =
      last.length > room ? `${last.slice(0, room).trimEnd()}\n\n${marker}` : `${last}\n\n${marker}`;
    return { chunks: kept, truncated: true };
  }

  getInboundHandler(id: string): InboundHandler | null {
    return this.inbound.get(id) ?? null;
  }
}

export function splitText(text: string, limit: number): string[] {
  const max = Math.max(1, limit);
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let split = rest.lastIndexOf("\n", max);
    if (split < Math.floor(max * 0.55)) split = max;
    chunks.push(rest.slice(0, split).trimEnd());
    rest = rest.slice(split).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
