import { describe, expect, test } from "bun:test";
import type { DynamicToolSpec } from "@finalbot/core";
import { compileCodexDynamicTools, resolveCodexDynamicToolCall } from "./index";

function tool(name: string): DynamicToolSpec {
  return {
    type: "function",
    name,
    description: name,
    inputSchema: { type: "object" },
  };
}

describe("Codex dynamic tools", () => {
  test("normalizes Responses API namespaces and preserves the internal route", () => {
    const compiled = compileCodexDynamicTools([
      tool("plugin.hello-world/greet"),
      tool("mcp.demo/search"),
      tool("standalone.tool"),
    ]);

    const namespaces = compiled.tools.filter((candidate) => candidate.type === "namespace");
    expect(namespaces.map((namespace) => namespace.name)).toEqual([
      "plugin_hello-world",
      "mcp_demo",
    ]);
    for (const namespace of namespaces) {
      expect(namespace.name).toMatch(/^[a-zA-Z0-9_-]+$/);
      for (const namespaceTool of namespace.tools) {
        expect(namespaceTool.name).toMatch(/^[a-zA-Z0-9_-]+$/);
      }
    }
    expect(compiled.routes.namespaces.get("plugin_hello-world")).toEqual({
      namespace: "plugin.hello-world",
      tools: new Map([["greet", "greet"]]),
    });
    expect(compiled.routes.namespaces.get("mcp_demo")).toEqual({
      namespace: "mcp.demo",
      tools: new Map([["search", "search"]]),
    });
    expect(compiled.routes.flatTools.get("standalone_tool")).toBe("standalone.tool");
    expect(resolveCodexDynamicToolCall(compiled.routes, "plugin_hello-world", "greet")).toEqual({
      namespace: "plugin.hello-world",
      tool: "greet",
    });
    expect(resolveCodexDynamicToolCall(compiled.routes, null, "standalone_tool")).toEqual({
      namespace: null,
      tool: "standalone.tool",
    });
  });

  test("disambiguates namespaces that normalize to the same value", () => {
    const compiled = compileCodexDynamicTools([tool("mcp.demo/search"), tool("mcp_demo/search")]);
    const namespaces = compiled.tools.filter((candidate) => candidate.type === "namespace");

    expect(new Set(namespaces.map((namespace) => namespace.name)).size).toBe(2);
    for (const namespace of namespaces) {
      expect(namespace.name).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
    expect(
      [...compiled.routes.namespaces.entries()].map(([namespace, route]) => [
        namespace,
        route.namespace,
        [...route.tools.values()],
      ]),
    ).toEqual([
      ["mcp_demo", "mcp.demo", ["search"]],
      [expect.stringMatching(/^mcp_demo_[a-f0-9]{8}$/), "mcp_demo", ["search"]],
    ]);
  });
});
