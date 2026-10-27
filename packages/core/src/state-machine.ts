import type { RunState } from "./contracts";

const TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  admitted: ["running", "cancelled", "failed"],
  running: [
    "waiting_approval",
    "retrying",
    "interrupted",
    "succeeded",
    "failed",
    "cancelled",
  ],
  waiting_approval: ["running", "interrupted", "failed", "cancelled"],
  retrying: ["running", "interrupted", "failed", "cancelled"],
  interrupted: ["running", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export class InvalidRunTransitionError extends Error {
  constructor(
    readonly from: RunState,
    readonly to: RunState,
  ) {
    super(`Invalid run transition: ${from} -> ${to}`);
    this.name = "InvalidRunTransitionError";
  }
}

export function canTransitionRun(from: RunState, to: RunState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertRunTransition(from: RunState, to: RunState): void {
  if (!canTransitionRun(from, to)) {
    throw new InvalidRunTransitionError(from, to);
  }
}

export function isTerminalRunState(state: RunState): boolean {
  return TRANSITIONS[state].length === 0;
}

