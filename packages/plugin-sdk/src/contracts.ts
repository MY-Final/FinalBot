import type { ToolInvocationContext } from "@finalbot/core";

export const PLUGIN_API_VERSION = 1;

export const PLUGIN_PERMISSIONS = ["tools", "events"] as const;
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

export const PLUGIN_EVENT_TYPES = [
  "run.updated",
  "run.delta",
  "approval.requested",
  "approval.resolved",
  "system",
] as const;
export type PluginEventType = (typeof PLUGIN_EVENT_TYPES)[number];

export interface PluginManifest {
  apiVersion: number;
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  entry: string;
  permissions: PluginPermission[];
  tools: string[];
}

export interface PluginLogDetails {
  [key: string]: unknown;
}

export interface PluginToolInvocationContext {
  runId: string;
  conversationId: string;
  botId: string;
  ownerId: string | null;
  toolSnapshotHash?: string;
  invokedAt: string;
}

export interface PluginToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(input: unknown, context: PluginToolInvocationContext): Promise<unknown> | unknown;
}

export interface PluginEvent {
  type: PluginEventType;
  payload: unknown;
  occurredAt: string;
}

export type PluginEventHandler = (event: PluginEvent) => Promise<void> | void;

export interface PluginContext {
  readonly pluginId: string;
  readonly version: string;
  readonly dataDir: string;
  registerTool(definition: PluginToolDefinition): void;
  registerEvent(type: PluginEventType, handler: PluginEventHandler): void;
  log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    details?: PluginLogDetails,
  ): void;
}

export interface FinalBotPlugin {
  activate(context: PluginContext): Promise<void> | void;
  deactivate?(): Promise<void> | void;
}

export interface PluginModule {
  default?: FinalBotPlugin;
  plugin?: FinalBotPlugin;
}

export interface PluginRuntimeTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface PluginActivationResult {
  tools: PluginRuntimeTool[];
  events: PluginEventType[];
}

export interface PluginInvocation {
  toolName: string;
  input: unknown;
  context: PluginToolInvocationContext;
}

export interface PluginEventDispatchResult {
  pluginId: string;
  ok: boolean;
  error?: string;
}

export function pluginInvocationContext(
  context: ToolInvocationContext,
): PluginToolInvocationContext {
  return {
    runId: context.runId,
    conversationId: context.conversationId,
    botId: context.botId,
    ownerId: context.ownerId,
    ...(context.toolSnapshotHash ? { toolSnapshotHash: context.toolSnapshotHash } : {}),
    invokedAt: new Date().toISOString(),
  };
}

export function definePlugin(plugin: FinalBotPlugin): FinalBotPlugin {
  return plugin;
}

export function parsePluginManifest(value: unknown, expectedId?: string): PluginManifest {
  if (!isRecord(value)) throw new Error("metadata.json must contain an object");
  if (value.apiVersion !== PLUGIN_API_VERSION) {
    throw new Error(`Unsupported plugin apiVersion: ${String(value.apiVersion)}`);
  }
  const id = requiredString(value, "id", 48);
  if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(id)) {
    throw new Error("Plugin id must use lowercase letters, numbers, '-' or '_'");
  }
  if (expectedId && id !== expectedId) {
    throw new Error(`Plugin id '${id}' must match directory '${expectedId}'`);
  }
  const name = requiredString(value, "name", 120);
  const version = requiredString(value, "version", 48);
  const description = requiredString(value, "description", 2_000);
  const author = optionalString(value.author, 120);
  const entry = requiredString(value, "entry", 240).replaceAll("\\", "/");
  if (
    entry.startsWith("/") ||
    entry.startsWith("../") ||
    entry.includes("/../") ||
    entry === ".."
  ) {
    throw new Error("Plugin entry must stay inside the plugin directory");
  }
  if (!/\.[cm]?[jt]sx?$/i.test(entry)) {
    throw new Error("Plugin entry must be a JavaScript or TypeScript file");
  }
  if (!Array.isArray(value.permissions)) {
    throw new Error("Plugin permissions must be an array");
  }
  const permissions = [...new Set(value.permissions)].map((permission) => {
    if (
      typeof permission !== "string" ||
      !PLUGIN_PERMISSIONS.includes(permission as PluginPermission)
    ) {
      throw new Error(`Unknown plugin permission: ${String(permission)}`);
    }
    return permission as PluginPermission;
  });
  const toolsValue = value.tools ?? [];
  if (!Array.isArray(toolsValue)) throw new Error("Plugin tools must be an array");
  if (toolsValue.length > 64) throw new Error("A plugin may declare at most 64 tools");
  const tools = [...new Set(toolsValue)].map((toolName) => {
    if (typeof toolName !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(toolName)) {
      throw new Error(`Invalid plugin tool name: ${String(toolName)}`);
    }
    return toolName;
  });
  if (tools.length > 0 && !permissions.includes("tools")) {
    throw new Error("Declared plugin tools require the 'tools' permission");
  }
  return {
    apiVersion: PLUGIN_API_VERSION,
    id,
    name,
    version,
    description,
    ...(author ? { author } : {}),
    entry,
    permissions,
    tools,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(input: Record<string, unknown>, key: string, maxLength: number): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`${key} must be at most ${maxLength} characters`);
  }
  return normalized;
}

function optionalString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`Value must be at most ${maxLength} characters`);
  }
  return normalized;
}
