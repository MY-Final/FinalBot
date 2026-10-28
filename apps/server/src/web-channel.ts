import type {
  ChannelAdapter,
  ChannelState,
  OutboundAddress,
  OutboundMessage,
  SendResult,
} from "@finalbot/core";

export class WebChannelAdapter implements ChannelAdapter {
  readonly id = "web";
  private connected = true;
  private lastError: string | null = null;
  private readonly sent: Array<{ text: string; at: string }> = [];

  getState(): ChannelState {
    return {
      id: this.id,
      type: "web",
      enabled: true,
      configured: true,
      connected: this.connected,
      accountId: "local",
      capabilities: {
        observeAll: true,
        proactiveSend: true,
        reply: true,
        markdown: true,
        maxTextLength: 100_000,
      },
      lastError: this.lastError,
    };
  }

  async start(): Promise<void> {
    this.connected = true;
    this.lastError = null;
  }

  async stop(): Promise<void> {
    this.connected = false;
  }

  async send(_address: OutboundAddress, message: OutboundMessage): Promise<SendResult> {
    if (!this.connected) throw new Error("Web channel is disconnected");
    const deliveredAt = new Date().toISOString();
    this.sent.push({ text: message.text, at: deliveredAt });
    if (this.sent.length > 100) this.sent.shift();
    return { deliveredAt };
  }
}
