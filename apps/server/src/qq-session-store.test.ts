import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FinalBotDatabase } from "@finalbot/db";
import { SqliteQqSessionStore } from "./qq-session-store";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("SQLite QQ session store", () => {
  test("restores the gateway session after a database reopen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "finalbot-qq-session-"));
    tempDirs.push(dir);
    const path = join(dir, "test.sqlite");

    const firstDb = new FinalBotDatabase(path);
    try {
      new SqliteQqSessionStore(firstDb).save("app-1", {
        sessionId: "session-1",
        lastSeq: 42,
      });
    } finally {
      firstDb.close();
    }

    const secondDb = new FinalBotDatabase(path);
    try {
      const store = new SqliteQqSessionStore(secondDb);
      expect(store.load("app-1")).toEqual({
        sessionId: "session-1",
        lastSeq: 42,
      });
      store.clear("app-1");
      expect(store.load("app-1")).toBeNull();
    } finally {
      secondDb.close();
    }
  });
});
