import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const host = process.env.FINALBOT_HOST ?? "127.0.0.1";
const port = Number(process.env.FINALBOT_PORT ?? "8787");
const baseUrl = `http://${host}:${port}`;

if (!(await isHealthy())) {
  const serverEntry = findServerEntry();
  const child = Bun.spawn([serverEntry], {
    cwd: dirname(serverEntry),
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    env: processEnv(),
  });
  process.on("SIGINT", () => child.kill());
  process.on("SIGTERM", () => child.kill());
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await Bun.sleep(100);
    if (await isHealthy()) break;
  }
}

const command =
  process.platform === "win32"
    ? ["cmd", "/c", "start", "", baseUrl]
    : process.platform === "darwin"
      ? ["open", baseUrl]
      : ["xdg-open", baseUrl];

const opener = Bun.spawn(command, {
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
});
await opener.exited;

async function isHealthy(): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/health`, {
      signal: AbortSignal.timeout(700),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function findServerEntry(): string {
  const source = join(process.cwd(), "apps", "server", "src", "index.ts");
  if (existsSync(source)) return source;
  const nextToLauncher = join(import.meta.dir, "finalbot.exe");
  if (existsSync(nextToLauncher)) return nextToLauncher;
  throw new Error("FinalBot server entry was not found");
}

function processEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}
