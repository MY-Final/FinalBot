import type { ServerEvent } from "@finalbot/protocol";

type Subscriber = (event: ServerEvent) => void;

export class EventBus {
  private readonly subscribers = new Set<Subscriber>();

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  publish(event: ServerEvent): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch {
        // A disconnected UI must not interrupt a run.
      }
    }
  }
}

