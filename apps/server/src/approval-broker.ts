import type { ApprovalDecision } from "@finalbot/core";

interface Waiter {
  resolve: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ApprovalBroker {
  private readonly waiters = new Map<string, Waiter>();

  wait(requestId: string, timeoutMs = 15 * 60 * 1000): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(requestId);
        resolve({ action: "cancel" });
      }, timeoutMs);
      this.waiters.set(requestId, { resolve, timer });
    });
  }

  resolve(requestId: string, decision: ApprovalDecision): boolean {
    const waiter = this.waiters.get(requestId);
    if (!waiter) return false;
    this.waiters.delete(requestId);
    clearTimeout(waiter.timer);
    waiter.resolve(decision);
    return true;
  }

  cancel(requestId: string): boolean {
    return this.resolve(requestId, { action: "cancel" });
  }

  cancelAll(): void {
    for (const [requestId, waiter] of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve({ action: "cancel" });
      this.waiters.delete(requestId);
    }
  }
}
