import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import type { ToolDefinition, ToolInvocationContext } from "@finalbot/core";
import type { FinalBotDatabase, PluginRecord, PluginStatus } from "@finalbot/db";
import {
  PLUGIN_EVENT_TYPES,
  type PluginActivationResult,
  type PluginEvent,
  type PluginEventDispatchResult,
  type PluginEventType,
  type PluginInvocation,
  type PluginManifest,
  type PluginRuntimeTool,
  parsePluginManifest,
  pluginInvocationContext,
} from "./contracts";
import { PLUGIN_WORKER_SOURCE } from "./worker-source";

const METADATA_MAX_BYTES = 128 * 1024;
const DEFAULT_MAX_MESSAGE_BYTES = 512 * 1024;

export interface PluginManagerOptions {
  db: FinalBotDatabase;
  pluginDir: string;
  pluginDataDir: string;
  activationTimeoutMs?: number;
  toolTimeoutMs?: number;
  eventTimeoutMs?: number;
  maxMessageBytes?: number;
  onToolsChanged?: (tools: ToolDefinition[]) => void;
  logger?: Pick<Console, "debug" | "info" | "warn" | "error">;
}

export interface PluginSummary {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string | null;
  source: string;
  enabled: boolean;
  status: PluginStatus;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  tools: Array<{
    name: string;
    description: string;
    policy: "auto" | "ask" | "deny";
  }>;
  events: PluginEventType[];
}

interface DiscoveredPlugin {
  id: string;
  directory: string;
  entryPath: string;
  manifest: PluginManifest;
}

interface LoadedPlugin {
  descriptor: DiscoveredPlugin;
  worker: PluginWorker;
  result: PluginActivationResult;
}

type WorkerResponse =
  | {
      type: "response";
      requestId: number | null;
      ok: true;
      value: unknown;
    }
  | {
      type: "response";
      requestId: number | null;
      ok: false;
      error: string;
    }
  | {
      type: "log";
      level: "debug" | "info" | "warn" | "error";
      message: string;
      details?: unknown;
    }
  | {
      type: "fatal";
      error: string;
    };

export class PluginManager {
  private readonly maxMessageBytes: number;
  private readonly activationTimeoutMs: number;
  private readonly toolTimeoutMs: number;
  private readonly eventTimeoutMs: number;
  private readonly logger: Pick<Console, "debug" | "info" | "warn" | "error">;
  private readonly discovered = new Map<string, DiscoveredPlugin>();
  private readonly loaded = new Map<string, LoadedPlugin>();
  private toolsChangedHandler: ((tools: ToolDefinition[]) => void) | null;
  private closed = false;

  constructor(private readonly options: PluginManagerOptions) {
    this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    this.activationTimeoutMs = options.activationTimeoutMs ?? 10_000;
    this.toolTimeoutMs = options.toolTimeoutMs ?? 30_000;
    this.eventTimeoutMs = options.eventTimeoutMs ?? 10_000;
    this.logger = options.logger ?? console;
    this.toolsChangedHandler = options.onToolsChanged ?? null;
  }

  setToolsChangedHandler(handler: ((tools: ToolDefinition[]) => void) | null): void {
    this.toolsChangedHandler = handler;
  }

  async reload(): Promise<PluginSummary[]> {
    this.closed = false;
    await this.closeLoaded(false);
    await this.discover();
    for (const record of this.options.db.listPlugins()) {
      if (!record.enabled) {
        if (record.status !== "error" && record.status !== "missing") {
          this.options.db.updatePluginStatus(record.id, "disabled", null);
        }
        continue;
      }
      const descriptor = this.discovered.get(record.id);
      if (!descriptor) continue;
      try {
        await this.activate(descriptor);
      } catch (error) {
        this.markPluginError(record.id, error);
      }
    }
    this.notifyToolsChanged();
    return this.list();
  }

  async enable(pluginId: string): Promise<PluginSummary[]> {
    if (!this.discovered.has(pluginId)) await this.discover();
    const descriptor = this.discovered.get(pluginId);
    if (!descriptor) throw new Error(`Plugin not found: ${pluginId}`);
    this.options.db.setPluginEnabled(pluginId, true);
    if (!this.loaded.has(pluginId)) {
      try {
        await this.activate(descriptor);
      } catch (error) {
        this.markPluginError(pluginId, error);
        this.notifyToolsChanged();
        throw error;
      }
    }
    this.notifyToolsChanged();
    return this.list();
  }

  async disable(pluginId: string): Promise<PluginSummary[]> {
    const record = this.options.db.getPlugin(pluginId);
    if (!record) throw new Error(`Plugin not found: ${pluginId}`);
    this.options.db.setPluginEnabled(pluginId, false);
    const loaded = this.loaded.get(pluginId);
    if (loaded) {
      this.loaded.delete(pluginId);
      await loaded.worker.close();
    }
    this.notifyToolsChanged();
    return this.list();
  }

  async reloadPlugin(pluginId: string): Promise<PluginSummary[]> {
    const record = this.options.db.getPlugin(pluginId);
    if (!record) throw new Error(`Plugin not found: ${pluginId}`);
    const loaded = this.loaded.get(pluginId);
    if (loaded) {
      this.loaded.delete(pluginId);
      await loaded.worker.close();
    }
    await this.discover();
    if (record.enabled) {
      const descriptor = this.discovered.get(pluginId);
      if (!descriptor) throw new Error(`Plugin directory is missing: ${pluginId}`);
      try {
        await this.activate(descriptor);
      } catch (error) {
        this.markPluginError(pluginId, error);
        this.notifyToolsChanged();
        throw error;
      }
    }
    this.notifyToolsChanged();
    return this.list();
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.closeLoaded(true);
    this.discovered.clear();
  }

  list(): PluginSummary[] {
    return this.options.db.listPlugins().map((record) => {
      const loaded = this.loaded.get(record.id);
      return {
        id: record.id,
        name: record.name,
        version: record.version,
        description: record.description,
        author: record.author,
        source: record.source,
        enabled: record.enabled,
        status: record.status,
        lastError: record.lastError,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        tools:
          loaded?.result.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            policy: this.options.db.getPluginToolPolicy(record.id, tool.name),
          })) ?? [],
        events: loaded?.result.events ?? [],
      };
    });
  }

  listTools(): ToolDefinition[] {
    return [...this.loaded.values()].flatMap((loaded) =>
      loaded.result.tools.map((tool) => this.toToolDefinition(loaded.descriptor, tool)),
    );
  }

  updateToolPolicy(pluginId: string, toolName: string, policy: "auto" | "ask" | "deny"): void {
    const loaded = this.loaded.get(pluginId);
    if (!loaded?.result.tools.some((tool) => tool.name === toolName)) {
      throw new Error(`Plugin tool not found: ${pluginId}/${toolName}`);
    }
    this.options.db.setPluginToolPolicy(pluginId, toolName, policy);
    this.notifyToolsChanged();
  }

  async dispatchEvent(
    type: PluginEventType,
    payload: unknown,
  ): Promise<PluginEventDispatchResult[]> {
    const event: PluginEvent = {
      type,
      payload,
      occurredAt: new Date().toISOString(),
    };
    const results: PluginEventDispatchResult[] = [];
    await Promise.all(
      [...this.loaded.values()].map(async (loaded) => {
        if (!loaded.result.events.includes(type)) return;
        try {
          await loaded.worker.request("event", { event }, this.eventTimeoutMs);
          results.push({ pluginId: loaded.descriptor.id, ok: true });
        } catch (error) {
          const message = errorMessage(error);
          results.push({ pluginId: loaded.descriptor.id, ok: false, error: message });
          this.logger.warn(
            `[finalbot] plugin event failed ${loaded.descriptor.id}/${type}: ${message}`,
          );
        }
      }),
    );
    return results;
  }

  static eventType(value: string): PluginEventType | null {
    return PLUGIN_EVENT_TYPES.includes(value as PluginEventType)
      ? (value as PluginEventType)
      : null;
  }

  private async discover(): Promise<void> {
    await mkdir(this.options.pluginDir, { recursive: true });
    await mkdir(this.options.pluginDataDir, { recursive: true });
    const entries = await readdir(this.options.pluginDir, { withFileTypes: true });
    const discoveredIds = new Set<string>();
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const directory = resolve(join(this.options.pluginDir, entry.name));
      const metadataPath = join(directory, "metadata.json");
      let raw: unknown;
      try {
        const metadata = await readFile(metadataPath, "utf8");
        if (Buffer.byteLength(metadata) > METADATA_MAX_BYTES) {
          throw new Error("metadata.json exceeds 128 KiB");
        }
        raw = JSON.parse(metadata);
      } catch (error) {
        const recordedId = this.recordInvalidManifest(entry.name, metadataPath, error);
        if (recordedId) discoveredIds.add(recordedId);
        continue;
      }
      try {
        const manifest = parsePluginManifest(raw, entry.name);
        const entryPath = resolve(directory, manifest.entry);
        const entryRelative = relative(directory, entryPath);
        if (!entryRelative || entryRelative.startsWith("..") || isAbsolute(entryRelative)) {
          throw new Error("Plugin entry must stay inside the plugin directory");
        }
        await readFile(entryPath, { encoding: "utf8" });
        const descriptor: DiscoveredPlugin = {
          id: manifest.id,
          directory,
          entryPath,
          manifest,
        };
        this.discovered.set(descriptor.id, descriptor);
        discoveredIds.add(descriptor.id);
        this.options.db.upsertDiscoveredPlugin({
          id: descriptor.id,
          name: manifest.name,
          version: manifest.version,
          description: manifest.description,
          author: manifest.author ?? null,
          entryPath,
          manifest: {
            apiVersion: manifest.apiVersion,
            entry: manifest.entry,
            permissions: manifest.permissions,
            tools: manifest.tools,
          },
        });
      } catch (error) {
        const recordedId = this.recordInvalidManifest(entry.name, metadataPath, error);
        if (recordedId) discoveredIds.add(recordedId);
      }
    }
    for (const record of this.options.db.listPlugins()) {
      if (discoveredIds.has(record.id)) continue;
      if (!this.isValidPluginId(record.id)) continue;
      this.discovered.delete(record.id);
      this.options.db.updatePluginStatus(
        record.id,
        "missing",
        `Plugin directory not found: ${record.id}`,
      );
    }
  }

  private recordInvalidManifest(
    directoryName: string,
    metadataPath: string,
    error: unknown,
  ): string | null {
    const message = errorMessage(error);
    if (!this.isValidPluginId(directoryName)) {
      this.logger.warn(`[finalbot] ignored invalid plugin directory ${directoryName}: ${message}`);
      return null;
    }
    this.discovered.delete(directoryName);
    this.options.db.upsertDiscoveredPlugin({
      id: directoryName,
      name: directoryName,
      version: "unknown",
      description: "Plugin manifest could not be loaded.",
      entryPath: metadataPath,
      manifest: {},
      error: message,
    });
    return directoryName;
  }

  private async activate(descriptor: DiscoveredPlugin): Promise<void> {
    this.options.db.updatePluginStatus(descriptor.id, "loading", null);
    const pluginDataDir = join(this.options.pluginDataDir, descriptor.id);
    await mkdir(pluginDataDir, { recursive: true });
    const worker = new PluginWorker({
      source: PLUGIN_WORKER_SOURCE,
      workerData: {
        pluginId: descriptor.id,
        version: descriptor.manifest.version,
        entryPath: descriptor.entryPath,
        pluginDataDir,
        permissions: descriptor.manifest.permissions,
        tools: descriptor.manifest.tools,
        eventTypes: PLUGIN_EVENT_TYPES,
        maxMessageBytes: this.maxMessageBytes,
        safeEnv: safeWorkerEnvironment(),
      },
      logger: this.logger,
      maxMessageBytes: this.maxMessageBytes,
      onFatal: (error) => this.handleWorkerFatal(descriptor.id, error),
    });
    try {
      const result = (await worker.request(
        "activate",
        {},
        this.activationTimeoutMs,
      )) as PluginActivationResult;
      validateActivationResult(descriptor.manifest, result);
      this.loaded.set(descriptor.id, { descriptor, worker, result });
      this.options.db.updatePluginStatus(descriptor.id, "active", null);
      this.logger.info(`[finalbot] plugin active ${descriptor.id}@${descriptor.manifest.version}`);
    } catch (error) {
      await worker.close();
      throw error;
    }
  }

  private toToolDefinition(descriptor: DiscoveredPlugin, tool: PluginRuntimeTool): ToolDefinition {
    return {
      namespace: `plugin.${descriptor.id}`,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      policy: this.options.db.getPluginToolPolicy(descriptor.id, tool.name),
      execute: async (input, context) => this.callTool(descriptor.id, tool.name, input, context),
    };
  }

  private async callTool(
    pluginId: string,
    toolName: string,
    input: unknown,
    context: ToolInvocationContext,
  ): Promise<unknown> {
    const loaded = this.loaded.get(pluginId);
    if (!loaded) throw new Error(`Plugin is not active: ${pluginId}`);
    const invocation: PluginInvocation = {
      toolName,
      input,
      context: pluginInvocationContext(context),
    };
    return loaded.worker.request("call-tool", invocation, this.toolTimeoutMs);
  }

  private handleWorkerFatal(pluginId: string, error: Error): void {
    const loaded = this.loaded.get(pluginId);
    if (!loaded) return;
    this.loaded.delete(pluginId);
    this.options.db.updatePluginStatus(pluginId, "error", error.message);
    this.logger.error(`[finalbot] plugin stopped ${pluginId}: ${error.message}`);
    this.notifyToolsChanged();
  }

  private markPluginError(pluginId: string, error: unknown): void {
    const message = errorMessage(error);
    this.options.db.updatePluginStatus(pluginId, "error", message);
    this.logger.warn(`[finalbot] plugin failed ${pluginId}: ${message}`);
  }

  private async closeLoaded(notify: boolean): Promise<void> {
    const loaded = [...this.loaded.values()];
    this.loaded.clear();
    await Promise.all(loaded.map((plugin) => plugin.worker.close()));
    if (notify) this.notifyToolsChanged();
  }

  private notifyToolsChanged(): void {
    if (this.closed) return;
    this.toolsChangedHandler?.(this.listTools());
  }

  private isValidPluginId(value: string): boolean {
    return /^[a-z0-9][a-z0-9_-]{0,47}$/.test(value);
  }
}

class PluginWorker {
  private readonly worker: Worker;
  private readonly fatalHandler: (error: Error) => void;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private nextRequestId = 1;
  private fatalError: Error | null = null;
  private stopping = false;

  constructor(options: {
    source: string;
    workerData: Record<string, unknown>;
    logger: Pick<Console, "debug" | "info" | "warn" | "error">;
    maxMessageBytes: number;
    onFatal: (error: Error) => void;
  }) {
    this.fatalHandler = options.onFatal;
    this.worker = new Worker(options.source, {
      eval: true,
      workerData: options.workerData,
      env: options.workerData.safeEnv as Record<string, string>,
    });
    this.worker.on("message", (message: WorkerResponse) => {
      if (message.type === "log") {
        const log = options.logger[message.level];
        log(
          `[plugin:${String(options.workerData.pluginId)}] ${message.message}`,
          ...(message.details === undefined ? [] : [message.details]),
        );
        return;
      }
      if (message.type === "fatal") {
        this.fail(new Error(message.error), options.onFatal);
        return;
      }
      if (message.requestId === null) return;
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      if (message.ok) {
        pending.resolve(message.value);
      } else {
        pending.reject(new Error(message.error));
      }
    });
    this.worker.on("error", (error) => {
      this.fail(error instanceof Error ? error : new Error(String(error)), options.onFatal);
    });
    this.worker.on("exit", (code) => {
      if (this.stopping) return;
      this.fail(new Error(`Plugin worker exited with code ${code}`), options.onFatal);
    });
    this.maxMessageBytes = options.maxMessageBytes;
  }

  private readonly maxMessageBytes: number;

  request(
    type: "activate" | "deactivate" | "call-tool" | "event",
    payload: object,
    timeoutMs: number,
  ): Promise<unknown> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    const requestId = this.nextRequestId++;
    const message = { type, requestId, ...payload };
    const size = byteLength(message);
    if (size > this.maxMessageBytes) {
      return Promise.reject(new Error(`Plugin request exceeded ${this.maxMessageBytes} bytes`));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`Plugin request timed out: ${type}`);
        this.pending.delete(requestId);
        reject(error);
        this.fail(error, this.fatalHandler);
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.worker.postMessage(message);
    });
  }

  async close(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (!this.fatalError) {
      await this.request("deactivate", {}, 2_000).catch(() => undefined);
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Plugin worker closed"));
    }
    this.pending.clear();
    await this.worker.terminate().catch(() => undefined);
  }

  private fail(error: Error, onFatal: (error: Error) => void): void {
    if (this.fatalError || this.stopping) return;
    this.fatalError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    onFatal(error);
    void this.worker.terminate().catch(() => undefined);
  }
}

function validateActivationResult(manifest: PluginManifest, result: PluginActivationResult): void {
  if (!result || typeof result !== "object") {
    throw new Error("Plugin activation returned an invalid result");
  }
  const tools = Array.isArray(result.tools) ? result.tools : [];
  const events = Array.isArray(result.events) ? result.events : [];
  const names = new Set<string>();
  for (const tool of tools) {
    if (
      !tool ||
      typeof tool.name !== "string" ||
      typeof tool.description !== "string" ||
      !tool.inputSchema ||
      typeof tool.inputSchema !== "object" ||
      Array.isArray(tool.inputSchema)
    ) {
      throw new Error("Plugin registered an invalid tool definition");
    }
    if (names.has(tool.name)) throw new Error(`Plugin registered duplicate tool: ${tool.name}`);
    names.add(tool.name);
    if (!manifest.tools.includes(tool.name)) {
      throw new Error(`Plugin registered an undeclared tool: ${tool.name}`);
    }
  }
  for (const toolName of manifest.tools) {
    if (!names.has(toolName)) {
      throw new Error(`Plugin did not register declared tool: ${toolName}`);
    }
  }
  for (const event of events) {
    if (!PLUGIN_EVENT_TYPES.includes(event)) {
      throw new Error(`Plugin registered an unsupported event: ${String(event)}`);
    }
  }
}

function safeWorkerEnvironment(): Record<string, string> {
  const allowed = ["TZ", "LANG", "LC_ALL", "TMP", "TEMP", "TMPDIR"];
  const env: Record<string, string> = {};
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function pluginToolHash(record: PluginRecord): string {
  return createHash("sha256")
    .update(`${record.id}:${record.version}:${record.updatedAt}`)
    .digest("hex");
}
