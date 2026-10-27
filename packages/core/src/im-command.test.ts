import { describe, expect, test } from "bun:test";
import { parseImCommand, stripLeadingMentions } from "./im-command";

describe("IM command parsing", () => {
  test("does not consume normal chat prompts", () => {
    expect(parseImCommand("帮我看一下这个仓库")).toBeNull();
  });

  test("removes group mentions before parsing", () => {
    expect(stripLeadingMentions("@123456 /status")).toBe("/status");
    expect(stripLeadingMentions("[CQ:at,qq=123456] /stop")).toBe("/stop");
    expect(parseImCommand("@123456 /approve approval_abc")).toEqual({
      kind: "approve",
      requestId: "approval_abc",
      raw: "/approve approval_abc",
    });
  });

  test("parses approval and interruption commands", () => {
    expect(parseImCommand("/approve")).toEqual({ kind: "approve", raw: "/approve" });
    expect(parseImCommand("/approve_session approval_1")).toEqual({
      kind: "approve_session",
      requestId: "approval_1",
      raw: "/approve_session approval_1",
    });
    expect(parseImCommand("/deny")).toEqual({ kind: "deny", raw: "/deny" });
    expect(parseImCommand("/stop")).toEqual({ kind: "cancel", raw: "/stop" });
    expect(parseImCommand("/cancel")).toEqual({ kind: "cancel", raw: "/cancel" });
  });

  test("supports status/help aliases and rejects malformed arguments", () => {
    expect(parseImCommand("/status")).toEqual({ kind: "status", raw: "/status" });
    expect(parseImCommand("/帮助")).toEqual({ kind: "help", raw: "/帮助" });
    expect(parseImCommand("/approve two ids")).toEqual({
      kind: "unknown",
      raw: "/approve two ids",
    });
  });
});
