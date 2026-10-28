import { describe, expect, test } from "bun:test";
import { QuickJsCodeSandbox } from "./index";

describe("QuickJS code sandbox", () => {
  test("runs code and bridges tools without host capabilities", async () => {
    const sandbox = new QuickJsCodeSandbox({ timeoutMs: 5_000 });
    const result = await sandbox.run({
      code: `
        const value = await tools.memory.search({ query: "hello" });
        return { value, access: typeof process + "/" + typeof fetch };
      `,
      callTool: async (path, args) => ({ path, args }),
    });
    expect(result.success).toBe(true);
    expect(result.output).toEqual({
      value: { path: "memory/search", args: { query: "hello" } },
      access: "undefined/undefined",
    });
  });

  test("interrupts infinite loops", async () => {
    const sandbox = new QuickJsCodeSandbox({ timeoutMs: 100 });
    const result = await sandbox.run({
      code: "while (true) {}",
      callTool: async () => null,
    });
    expect(result.success).toBe(false);
    expect(result.error?.toLowerCase()).toContain("timed out");
  });

  test("replays journaled calls during resume", async () => {
    const journal = new Map<string, unknown>();
    const sandbox = new QuickJsCodeSandbox({ timeoutMs: 5_000 });
    let calls = 0;
    const run = await sandbox.run({
      code: `return await tools.demo.echo({ value: 1 })`,
      callTool: async () => {
        calls += 1;
        return { ok: true };
      },
      journal,
    });
    expect(run.success).toBe(true);
    expect(calls).toBe(1);
    const replay = await sandbox.run({
      code: `return await tools.demo.echo({ value: 1 })`,
      callTool: async () => {
        calls += 1;
        return { wrong: true };
      },
      journal,
    });
    expect(replay.success).toBe(true);
    expect(calls).toBe(1);
  });

  test("journals identical calls by execution position", async () => {
    const journal = new Map<string, unknown>();
    const sandbox = new QuickJsCodeSandbox({ timeoutMs: 5_000 });
    let calls = 0;
    const code = `
      const first = await tools.demo.echo({ value: 1 });
      const second = await tools.demo.echo({ value: 1 });
      return [first, second];
    `;
    const run = await sandbox.run({
      code,
      callTool: async () => {
        calls += 1;
        return { call: calls };
      },
      journal,
    });
    expect(run.success).toBe(true);
    expect(calls).toBe(2);
    expect(run.output).toEqual([{ call: 1 }, { call: 2 }]);

    const replay = await sandbox.run({
      code,
      callTool: async () => {
        calls += 1;
        return { call: calls };
      },
      journal,
    });
    expect(replay.success).toBe(true);
    expect(calls).toBe(2);
    expect(replay.output).toEqual([{ call: 1 }, { call: 2 }]);
  });

  test("exposes no fetch, process, require or filesystem globals", async () => {
    const sandbox = new QuickJsCodeSandbox({ timeoutMs: 5_000 });
    const result = await sandbox.run({
      code: `return [typeof fetch, typeof process, typeof require, typeof Bun].join("/")`,
      callTool: async () => null,
    });
    expect(result.success).toBe(true);
    expect(result.output).toBe("undefined/undefined/undefined/undefined");
  });

  test("enforces the tool-call and result bounds", async () => {
    const sandbox = new QuickJsCodeSandbox({
      timeoutMs: 5_000,
      maxToolCalls: 2,
      maxResultBytes: 128,
    });
    const limited = await sandbox.run({
      code: `
        await tools.demo.one({});
        await tools.demo.two({});
        await tools.demo.three({});
        return true;
      `,
      callTool: async () => ({ ok: true }),
    });
    expect(limited.success).toBe(false);
    expect(limited.error?.toLowerCase()).toContain("tool call limit");
    expect(limited.toolCalls).toHaveLength(2);

    const truncated = await sandbox.run({
      code: `return "x".repeat(1000)`,
      callTool: async () => null,
    });
    expect(truncated.success).toBe(true);
    expect(truncated.output).toMatchObject({ truncated: true });
  });
});
