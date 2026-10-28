let runUpdates = 0;

export default {
  activate(context) {
    context.registerTool({
      name: "greet",
      description: "Return a greeting for the requested name.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 80 },
        },
        required: ["name"],
        additionalProperties: false,
      },
      run(input, invocation) {
        return {
          message: `Hello ${input.name}`,
          botId: invocation.botId,
          runId: invocation.runId,
        };
      },
    });

    context.registerEvent("run.updated", () => {
      runUpdates += 1;
      context.log("debug", "observed a run update", { runUpdates });
    });

    context.log("info", "hello-world activated", { dataDir: context.dataDir });
  },

  deactivate() {
    runUpdates = 0;
  },
};
