export const PLUGIN_WORKER_SOURCE = `
(async () => {
  const { parentPort, workerData } = await import("node:worker_threads");
  const { pathToFileURL } = await import("node:url");

  if (!parentPort) throw new Error("Plugin worker has no parent port");

  const maxMessageBytes = Number(workerData.maxMessageBytes || 512 * 1024);
  const permissions = new Set(workerData.permissions || []);
  const declaredTools = new Set(workerData.tools || []);
  const allowedEvents = new Set(workerData.eventTypes || []);
  const tools = new Map();
  const events = new Map();
  let plugin = null;
  let stopped = false;

  function byteLength(value) {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  }

  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }

  function send(message) {
    if (byteLength(message) > maxMessageBytes) {
      parentPort.postMessage({
        type: "response",
        requestId: message.requestId,
        ok: false,
        error: "Plugin message exceeded the configured size limit",
      });
      return;
    }
    parentPort.postMessage(message);
  }

  function scrubEnvironment() {
    const processValue = globalThis.process;
    if (!processValue || !processValue.env) return;
    for (const key of Object.keys(processValue.env)) {
      try {
        delete processValue.env[key];
      } catch {
        // Environment variables may be read-only on some runtimes.
      }
    }
    for (const [key, value] of Object.entries(workerData.safeEnv || {})) {
      try {
        processValue.env[key] = String(value);
      } catch {
        // Ignore environment restoration failures.
      }
    }
  }

  function disableAmbientNetwork() {
    for (const key of ["fetch", "WebSocket", "EventSource", "XMLHttpRequest"]) {
      try {
        Object.defineProperty(globalThis, key, {
          configurable: false,
          enumerable: false,
          value: undefined,
          writable: false,
        });
      } catch {
        // The runtime may already provide a non-configurable global.
      }
    }
  }

  function createContext() {
    return {
      pluginId: workerData.pluginId,
      version: workerData.version,
      dataDir: workerData.pluginDataDir,
      registerTool(definition) {
        if (!permissions.has("tools")) {
          throw new Error("Plugin did not declare the 'tools' permission");
        }
        if (!definition || typeof definition !== "object") {
          throw new Error("Plugin tool definition must be an object");
        }
        if (
          typeof definition.name !== "string" ||
          !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(definition.name)
        ) {
          throw new Error("Plugin tool has an invalid name");
        }
        if (!declaredTools.has(definition.name)) {
          throw new Error("Plugin tool was not declared in metadata.json: " + definition.name);
        }
        if (tools.has(definition.name)) {
          throw new Error("Duplicate plugin tool: " + definition.name);
        }
        if (typeof definition.description !== "string" || !definition.description.trim()) {
          throw new Error("Plugin tool description is required");
        }
        if (
          !definition.inputSchema ||
          typeof definition.inputSchema !== "object" ||
          Array.isArray(definition.inputSchema)
        ) {
          throw new Error("Plugin tool inputSchema must be an object");
        }
        if (typeof definition.run !== "function") {
          throw new Error("Plugin tool run() must be a function");
        }
        tools.set(definition.name, definition);
      },
      registerEvent(type, handler) {
        if (!permissions.has("events")) {
          throw new Error("Plugin did not declare the 'events' permission");
        }
        if (!allowedEvents.has(type)) {
          throw new Error("Unsupported plugin event: " + String(type));
        }
        if (typeof handler !== "function") {
          throw new Error("Plugin event handler must be a function");
        }
        const handlers = events.get(type) || [];
        if (handlers.length >= 16) {
          throw new Error("A plugin may register at most 16 handlers for one event");
        }
        handlers.push(handler);
        events.set(type, handlers);
      },
      log(level, message, details) {
        send({
          type: "log",
          level: ["debug", "info", "warn", "error"].includes(level) ? level : "info",
          message: String(message).slice(0, 4_000),
          details: details === undefined ? null : details,
        });
      },
    };
  }

  async function activate() {
    if (plugin) throw new Error("Plugin is already active");
    scrubEnvironment();
    disableAmbientNetwork();
    const url = pathToFileURL(workerData.entryPath).href;
    const loaded = await import(url);
    plugin = loaded.default || loaded.plugin || loaded;
    if (!plugin || typeof plugin.activate !== "function") {
      throw new Error("Plugin entry must export a plugin with activate(context)");
    }
    await plugin.activate(createContext());
    const missing = [...declaredTools].filter((name) => !tools.has(name));
    if (missing.length > 0) {
      throw new Error("Plugin did not register declared tools: " + missing.join(", "));
    }
    return {
      tools: [...tools.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
      events: [...events.keys()],
    };
  }

  async function deactivate() {
    stopped = true;
    if (plugin && typeof plugin.deactivate === "function") {
      await plugin.deactivate();
    }
    tools.clear();
    events.clear();
    plugin = null;
  }

  async function handle(message) {
    if (!message || typeof message !== "object" || typeof message.type !== "string") return;
    const requestId =
      typeof message.requestId === "number" && Number.isSafeInteger(message.requestId)
        ? message.requestId
        : null;
    try {
      if (message.type === "activate") {
        send({ type: "response", requestId, ok: true, value: await activate() });
        return;
      }
      if (message.type === "deactivate") {
        await deactivate();
        send({ type: "response", requestId, ok: true, value: null });
        return;
      }
      if (stopped) throw new Error("Plugin worker is stopping");
      if (message.type === "call-tool") {
        const tool = tools.get(message.toolName);
        if (!tool) throw new Error("Unknown plugin tool: " + String(message.toolName));
        const result = await tool.run(message.input, message.context);
        send({
          type: "response",
          requestId,
          ok: true,
          value: result === undefined ? null : result,
        });
        return;
      }
      if (message.type === "event") {
        const handlers = events.get(message.event && message.event.type) || [];
        for (const handler of handlers) {
          await handler(message.event);
        }
        send({ type: "response", requestId, ok: true, value: { handled: handlers.length } });
        return;
      }
      throw new Error("Unknown plugin worker command: " + message.type);
    } catch (error) {
      send({
        type: "response",
        requestId,
        ok: false,
        error: errorMessage(error),
      });
    }
  }

  parentPort.on("message", async (message) => {
    await handle(message);
  });
})().catch(async (error) => {
  try {
    const { parentPort } = await import("node:worker_threads");
    parentPort?.postMessage({
      type: "fatal",
      error: error instanceof Error ? error.stack || error.message : String(error),
    });
  } catch {
    // The process will exit with a non-zero status when the runtime is unavailable.
  }
});
`;
