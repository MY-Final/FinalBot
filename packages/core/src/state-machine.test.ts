import { describe, expect, test } from "bun:test";
import { assertRunTransition, canTransitionRun, isTerminalRunState } from "./state-machine";

describe("run state machine", () => {
  test("allows the successful path", () => {
    expect(canTransitionRun("admitted", "running")).toBe(true);
    expect(canTransitionRun("running", "succeeded")).toBe(true);
    expect(isTerminalRunState("succeeded")).toBe(true);
  });

  test("allows a run to pause for approval and continue", () => {
    expect(canTransitionRun("running", "waiting_approval")).toBe(true);
    expect(canTransitionRun("waiting_approval", "running")).toBe(true);
  });

  test("rejects transitions out of a terminal state", () => {
    expect(() => assertRunTransition("succeeded", "running")).toThrow(
      "Invalid run transition: succeeded -> running",
    );
  });
});

