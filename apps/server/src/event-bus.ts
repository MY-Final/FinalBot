import type { ServerEvent } from "@finalbot/protocol";

export interface EventEnvelope {
  seq: number | null;
  event: ServerEvent;
}

type Subscriber = (envelope: EventEnvelope) => void;

export class EventBus {
  private readonly subscribers = new Set<Subscriber>();

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  publish(envelope: EventEnvelope): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(envelope);
      } catch {
        // A disconnected UI must not interrupt a run.
      }
    }
  }
}
