import { resolve } from "node:path";
import { z } from "zod";

const envSchema = z.object({
  FINALBOT_HOST: z.string().default("127.0.0.1"),
  FINALBOT_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  FINALBOT_DATA_DIR: z.string().default("./data"),
  FINALBOT_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  FINALBOT_REPO_PATH: z.string().default(""),
  NAPCAT_WS_URL: z.string().default(""),
  NAPCAT_ACCESS_TOKEN: z.string().default(""),
  NAPCAT_ACCOUNT_ID: z.string().default(""),
  NAPCAT_PRIVATE_USER_IDS: z.string().default(""),
  NAPCAT_IGNORED_USER_IDS: z.string().default(""),
  NAPCAT_GROUP_REQUIRE_MENTION: z
    .enum(["0", "1"])
    .default("1")
    .transform((value) => value === "1"),
  FINALBOT_CODEX_BIN: z.string().default("codex"),
  FINALBOT_CODEX_MODEL: z.string().default(""),
  FINALBOT_CODEX_SANDBOX: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("workspace-write"),
  FINALBOT_MAX_CONCURRENT_RUNS: z.coerce.number().int().min(1).max(32).default(2),
  FINALBOT_FAKE_AGENT: z
    .enum(["0", "1"])
    .default("0")
    .transform((value) => value === "1"),
});

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  worktreesDir: string;
  logLevel: "debug" | "info" | "warn" | "error";
  repositoryPath: string | null;
  onebot: {
    wsUrl: string;
    accessToken: string;
    accountId: string;
    requireGroupMention: boolean;
    privateUserIds: string[];
    ignoredUserIds: string[];
  };
  codex: {
    executable: string;
    model: string | null;
    sandbox: "read-only" | "workspace-write" | "danger-full-access";
  };
  fakeAgent: boolean;
  maxConcurrentRuns: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const dataDir = resolve(parsed.FINALBOT_DATA_DIR);
  return {
    host: parsed.FINALBOT_HOST,
    port: parsed.FINALBOT_PORT,
    dataDir,
    databasePath: resolve(dataDir, "finalbot.sqlite"),
    worktreesDir: resolve(dataDir, "worktrees"),
    logLevel: parsed.FINALBOT_LOG_LEVEL,
    repositoryPath: parsed.FINALBOT_REPO_PATH ? resolve(parsed.FINALBOT_REPO_PATH) : null,
    onebot: {
      wsUrl: parsed.NAPCAT_WS_URL,
      accessToken: parsed.NAPCAT_ACCESS_TOKEN,
      accountId: parsed.NAPCAT_ACCOUNT_ID,
      requireGroupMention: parsed.NAPCAT_GROUP_REQUIRE_MENTION,
      privateUserIds: parseUserIds(parsed.NAPCAT_PRIVATE_USER_IDS),
      ignoredUserIds: parseUserIds(parsed.NAPCAT_IGNORED_USER_IDS),
    },
    codex: {
      executable: parsed.FINALBOT_CODEX_BIN,
      model: parsed.FINALBOT_CODEX_MODEL || null,
      sandbox: parsed.FINALBOT_CODEX_SANDBOX,
    },
    fakeAgent: parsed.FINALBOT_FAKE_AGENT,
    maxConcurrentRuns: parsed.FINALBOT_MAX_CONCURRENT_RUNS,
  };
}

function parseUserIds(value: string): string[] {
  return value
    .split(",")
    .map((id) => id.trim())
    .filter((id) => /^\d+$/.test(id));
}

