import releaseSyncVariant from "@jitl/quickjs-wasmfile-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";

export interface CodeSandboxOptions {
  timeoutMs?: number;
  memoryLimitBytes?: number;
  maxStackSizeBytes?: number;
  maxCodeBytes?: number;
  maxToolCalls?: number;
  maxResultBytes?: number;
}

export interface CodeSandboxRunInput {
  code: string;
  callTool(path: string, args: unknown): Promise<unknown>;
  journal?: Map<string, unknown>;
  onToolCall?: (call: {
    index: number;
    path: string;
    arguments: unknown;
    result: unknown;
    replayed: boolean;
  }) => void | Promise<void>;
}

export interface CodeSandboxResult {
  success: boolean;
  output: unknown;
  logs: string[];
  toolCalls: Array<{ path: string; arguments: unknown; result: unknown; replayed: boolean }>;
  error?: string;
}

const DEFAULTS: Required<CodeSandboxOptions> = {
  timeoutMs: 60_000,
  memoryLimitBytes: 64 * 1024 * 1024,
  maxStackSizeBytes: 1024 * 1024,
  maxCodeBytes: 1024 * 1024,
  maxToolCalls: 200,
  maxResultBytes: 256 * 1024,
};

let quickJsPromise: Promise<QuickJSWASMModule> | null = null;

function quickJs(): Promise<QuickJSWASMModule> {
  quickJsPromise ??= newQuickJSWASMModuleFromVariant(releaseSyncVariant);
  return quickJsPromise;
}

export class QuickJsCodeSandbox {
  private readonly options: Required<CodeSandboxOptions>;

  constructor(options: CodeSandboxOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  async run(input: CodeSandboxRunInput): Promise<CodeSandboxResult> {
    if (Buffer.byteLength(input.code) > this.options.maxCodeBytes) {
      return failure(`Code exceeds ${this.options.maxCodeBytes} bytes`);
    }
    const QuickJS = await quickJs();
    const runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(this.options.memoryLimitBytes);
    runtime.setMaxStackSize(this.options.maxStackSizeBytes);
    const startedAt = Date.now();
    runtime.setInterruptHandler(
      () => Date.now() - startedAt > this.options.timeoutMs || this.options.maxToolCalls < 0,
    );
    const context = runtime.newContext();
    const logs: string[] = [];
    const journal = input.journal ?? new Map<string, unknown>();
    const toolCalls: CodeSandboxResult["toolCalls"] = [];
    let callCount = 0;
    const pending = new Set<QuickJSDeferredPromise>();

    try {
      installConsole(context, logs);
      installToolBridge(context, pending, async (path, args) => {
        if (callCount >= this.options.maxToolCalls) {
          throw new Error(`Tool call limit exceeded (${this.options.maxToolCalls})`);
        }
        const callIndex = callCount;
        callCount += 1;
        const key = journalKey(callIndex);
        const legacyKey = legacyJournalKey(path, args);
        if (journal.has(key)) {
          const value = journal.get(key);
          const index = toolCalls.length;
          toolCalls.push({ path, arguments: args, result: value, replayed: true });
          await input.onToolCall?.({
            index,
            path,
            arguments: args,
            result: value,
            replayed: true,
          });
          return value;
        }
        if (!journal.has(key) && journal.has(legacyKey)) {
          const value = journal.get(legacyKey);
          const index = toolCalls.length;
          toolCalls.push({ path, arguments: args, result: value, replayed: true });
          await input.onToolCall?.({
            index,
            path,
            arguments: args,
            result: value,
            replayed: true,
          });
          return value;
        }
        const value = await input.callTool(path, args);
        journal.set(key, value);
        const index = toolCalls.length;
        toolCalls.push({ path, arguments: args, result: value, replayed: false });
        await input.onToolCall?.({
          index,
          path,
          arguments: args,
          result: value,
          replayed: false,
        });
        return value;
      });

      const wrapped = `
        globalThis.__finalbot_result = { settled: false };
        (async () => {
          try {
            const value = await (async () => {
              ${input.code}
            })();
            globalThis.__finalbot_result = { settled: true, value };
          } catch (error) {
            globalThis.__finalbot_result = {
              settled: true,
              error: error && typeof error === "object" && "stack" in error
                ? (error.message ? error.message + "\\n" : "") + error.stack
                : String(error),
            };
          }
        })();
      `;
      const evaluation = context.evalCode(wrapped, "finalbot-code-mode.js");
      if (evaluation.error) {
        throw new Error(readError(context, evaluation.error));
      }
      await drainJobs(runtime, pending);
      evaluation.value.dispose();
      const promiseState = readPromiseState(context);
      if (!promiseState.settled) throw new Error("Code did not settle");
      if (promiseState.error !== undefined) throw new Error(stringifyError(promiseState.error));
      return {
        success: true,
        output: truncateValue(promiseState.value, this.options.maxResultBytes),
        logs,
        toolCalls,
      };
    } catch (error) {
      if (Date.now() - startedAt >= this.options.timeoutMs) {
        const timedOut = {
          ...failure(`QuickJS execution timed out after ${this.options.timeoutMs}ms`),
          logs,
          toolCalls,
        };
        return timedOut;
      }
      return {
        ...failure(error instanceof Error ? error.message : String(error)),
        logs,
        toolCalls,
      };
    } finally {
      for (const deferred of pending) {
        if (deferred.alive) deferred.dispose();
      }
      context.dispose();
      runtime.dispose();
    }
  }
}

function installConsole(context: QuickJSContext, logs: string[]): void {
  const console = context.newObject();
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const fn = context.newFunction(level, (...args) => {
      const line = args
        .map((arg) => {
          const value = context.dump(arg);
          return typeof value === "string" ? value : JSON.stringify(value);
        })
        .join(" ");
      logs.push(`[${level}] ${line}`);
      return context.undefined;
    });
    context.setProp(console, level, fn);
    fn.dispose();
  }
  context.setProp(context.global, "console", console);
  console.dispose();
}

function installToolBridge(
  context: QuickJSContext,
  pending: Set<QuickJSDeferredPromise>,
  callTool: (path: string, args: unknown) => Promise<unknown>,
): void {
  const bridge = context.newFunction("__finalbot_call", (pathHandle, argsHandle) => {
    const path = context.getString(pathHandle);
    const args = context.dump(argsHandle);
    const deferred = context.newPromise();
    pending.add(deferred);
    void deferred.settled.finally(() => pending.delete(deferred));
    void callTool(path, args).then(
      (value) => {
        if (!deferred.alive) return;
        const handle = context.newString(JSON.stringify(value ?? null));
        deferred.resolve(handle);
        handle.dispose();
      },
      (error) => {
        if (!deferred.alive) return;
        const handle = context.newError(error instanceof Error ? error.message : String(error));
        deferred.reject(handle);
        handle.dispose();
      },
    );
    return deferred.handle;
  });
  context.setProp(context.global, "__finalbot_call", bridge);
  bridge.dispose();

  const setup = context.evalCode(`
    globalThis.tools = (() => {
      const build = (path) => {
        const node = (args) => Promise.resolve(__finalbot_call(path, args ?? {}))
          .then((value) => JSON.parse(value));
        return new Proxy(node, {
          get(_target, part) {
            if (typeof part !== "string" || part === "then" || part === "toJSON") return undefined;
            return build(path ? path + "/" + part : part);
          }
        });
      };
      return build("");
    })();
  `);
  if (setup.error) {
    const message = readError(context, setup.error);
    setup.error.dispose();
    throw new Error(message);
  }
  setup.value.dispose();
}

async function drainJobs(
  runtime: QuickJSRuntime,
  pending: ReadonlySet<QuickJSDeferredPromise>,
): Promise<void> {
  for (let index = 0; index < 1_000; index += 1) {
    const jobs = runtime.executePendingJobs(-1);
    if (jobs.error) {
      throw new Error("QuickJS pending job failed");
    }
    if (jobs.value > 0) {
      // Jobs ran; poll again because tool promises may have settled.
    }
    if (pending.size === 0 && jobs.value === 0) return;
    await Bun.sleep(1);
  }
  throw new Error("QuickJS async jobs did not settle");
}

function readPromiseState(context: QuickJSContext): {
  settled: boolean;
  value?: unknown;
  error?: unknown;
} {
  const stateHandle = context.evalCode(`
    (() => {
      const target = globalThis.__finalbot_result;
      return target ? { settled: true, value: target.value, error: target.error } : { settled: false };
    })()
  `);
  if (stateHandle.error) {
    stateHandle.error.dispose();
    return { settled: false };
  }
  const value = context.dump(stateHandle.value);
  stateHandle.value.dispose();
  if (!value || typeof value !== "object") return { settled: false };
  const record = value as Record<string, unknown>;
  return {
    settled: record.settled === true,
    ...(record.error !== undefined ? { error: record.error } : {}),
    ...(record.value !== undefined ? { value: record.value } : {}),
  };
}

function readError(context: QuickJSContext, handle: { dispose(): void }): string {
  try {
    try {
      return stringifyError(context.dump(handle as never));
    } catch {
      return "QuickJS execution failed";
    }
  } finally {
    handle.dispose();
  }
}

function stringifyError(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "message" in value) {
    return String((value as { message: unknown }).message);
  }
  return JSON.stringify(value);
}

function journalKey(callIndex: number): string {
  return `call:${callIndex}`;
}

function legacyJournalKey(path: string, args: unknown): string {
  return `${path}:${JSON.stringify(args ?? null)}`;
}

function truncateValue(value: unknown, maxBytes: number): unknown {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) <= maxBytes) return value;
  return { truncated: true, preview: text.slice(0, Math.max(1, Math.floor(maxBytes / 4))) };
}

function failure(message: string): CodeSandboxResult {
  return {
    success: false,
    output: null,
    logs: [],
    toolCalls: [],
    error: message,
  };
}
