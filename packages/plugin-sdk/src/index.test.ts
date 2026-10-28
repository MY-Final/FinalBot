import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolInvocationContext } from "@finalbot/core";
import { FinalBotDatabase } from "@finalbot/db";
import { PluginManager } from "./manager";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

describe("PluginManager", () => {
  test("loads tools in a worker, dispatches events, and honors enablement", async () => {
    const env = await setup();
    await writePlugin(env.pluginDir, "echo", {
      name: "Echo",
      tools: ["echo"],
      permissions: ["tools", "events"],
      source: `
let eventCount = 0;
export default {
  activate(context) {
    context.registerTool({
      name: "echo",
      description: "Echo a value",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"]
      },
      run(input, invocation) {
        return { value: input.value, eventCount, botId: invocation.botId };
      }
    });
    context.registerEvent("run.updated", () => {
      eventCount += 1;
    });
  }
};
`,
    });

    const initial = await env.manager.reload();
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({ id: "echo", enabled: false, status: "disabled" });
    expect(env.manager.listTools()).toHaveLength(0);

    await env.manager.enable("echo");
    expect(env.manager.list()).toEqual([
      expect.objectContaining({
        id: "echo",
        enabled: true,
        status: "active",
        tools: [
          expect.objectContaining({
            name: "echo",
            policy: "ask",
          }),
        ],
        events: ["run.updated"],
      }),
    ]);

    await env.manager.enable("echo");
    expect(env.manager.list()[0]).toMatchObject({
      enabled: true,
      status: "active",
    });

    const tool = env.manager.listTools()[0];
    expect(tool).toBeDefined();
    const firstResult = await tool?.execute({ value: "hello" }, invocationContext());
    expect(firstResult).toEqual({
      value: "hello",
      eventCount: 0,
      botId: "coder",
    });

    const dispatch = await env.manager.dispatchEvent("run.updated", { runId: "run_1" });
    expect(dispatch).toEqual([{ pluginId: "echo", ok: true }]);
    const secondResult = await tool?.execute({ value: "again" }, invocationContext());
    expect(secondResult).toEqual({
      value: "again",
      eventCount: 1,
      botId: "coder",
    });

    env.manager.updateToolPolicy("echo", "echo", "auto");
    expect(env.manager.listTools()[0]?.policy).toBe("auto");

    await env.manager.disable("echo");
    expect(env.manager.listTools()).toHaveLength(0);
    expect(env.manager.list()[0]).toMatchObject({ enabled: false, status: "disabled" });
  });

  test("reports invalid manifests without loading code", async () => {
    const env = await setup();
    const directory = join(env.pluginDir, "broken");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "metadata.json"), JSON.stringify({ id: "broken" }));

    const plugins = await env.manager.reload();
    expect(plugins).toEqual([
      expect.objectContaining({
        id: "broken",
        enabled: false,
        status: "error",
        lastError: expect.stringContaining("apiVersion"),
      }),
    ]);
    expect(env.manager.listTools()).toHaveLength(0);
  });

  test("terminates an activation that exceeds its timeout", async () => {
    const env = await setup({ activationTimeoutMs: 80 });
    await writePlugin(env.pluginDir, "slow", {
      name: "Slow",
      tools: [],
      permissions: [],
      source: `
export default {
  activate() {
    return new Promise(() => {});
  }
};
`,
    });

    await env.manager.reload();
    const record = env.db.getPlugin("slow");
    expect(record).toMatchObject({
      enabled: false,
      status: "disabled",
    });

    await expect(env.manager.enable("slow")).rejects.toThrow("timed out");
    expect(env.db.getPlugin("slow")).toMatchObject({
      enabled: true,
      status: "error",
      lastError: expect.stringContaining("timed out"),
    });
  });

  test("marks a plugin as failed when its worker crashes", async () => {
    const env = await setup();
    await writePlugin(env.pluginDir, "crasher", {
      name: "Crasher",
      tools: ["crash"],
      permissions: ["tools"],
      source: `
export default {
  activate(context) {
    context.registerTool({
      name: "crash",
      description: "Crash this worker",
      inputSchema: { type: "object", properties: {} },
      run() {
        process.exit(9);
      }
    });
  }
};
`,
    });
    await env.manager.reload();
    await env.manager.enable("crasher");

    const tool = env.manager.listTools()[0];
    await expect(tool?.execute({}, invocationContext())).rejects.toThrow();
    await Bun.sleep(50);
    expect(env.db.getPlugin("crasher")?.status).toBe("error");
    expect(env.manager.listTools()).toHaveLength(0);
  });
});

async function setup(overrides: { activationTimeoutMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "finalbot-plugin-"));
  const pluginDir = join(root, "plugins");
  const pluginDataDir = join(root, "plugin-data");
  const db = new FinalBotDatabase(join(root, "test.sqlite"));
  const manager = new PluginManager({
    db,
    pluginDir,
    pluginDataDir,
    activationTimeoutMs: overrides.activationTimeoutMs ?? 2_000,
    toolTimeoutMs: 2_000,
    eventTimeoutMs: 2_000,
  });
  cleanup.push(async () => {
    await manager.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return { db, manager, pluginDir, pluginDataDir };
}

async function writePlugin(
  pluginRoot: string,
  id: string,
  options: {
    name: string;
    tools: string[];
    permissions: string[];
    source: string;
  },
): Promise<void> {
  const directory = join(pluginRoot, id);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "metadata.json"),
    JSON.stringify(
      {
        apiVersion: 1,
        id,
        name: options.name,
        version: "1.0.0",
        description: `${options.name} test plugin`,
        entry: "index.js",
        permissions: options.permissions,
        tools: options.tools,
      },
      null,
      2,
    ),
  );
  await writeFile(join(directory, "index.js"), options.source);
}

function invocationContext(): ToolInvocationContext {
  return {
    runId: "run_1",
    conversationId: "conv_1",
    botId: "coder",
    ownerId: "owner_1",
  };
}
