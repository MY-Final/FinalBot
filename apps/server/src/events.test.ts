import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FinalBotDatabase } from "@finalbot/db";
import type { ServerEvent } from "@finalbot/protocol";
import { loadConfig } from "./config";
import { EventBus } from "./event-bus";
import { createApp } from "./index";
import { RunService } from "./run-service";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 3 })),
  );
});

describe("event streaming", () => {
  test("replays events after Last-Event-ID without replaying history for new clients", async () => {
    const dir = await mkdtemp(join(tmpdir(), "finalbot-events-"));
    tempDirs.push(dir);
    const db = new FinalBotDatabase(join(dir, "test.sqlite"));
    const bus = new EventBus();
    const config = loadConfig({
      FINALBOT_DATA_DIR: join(dir, "data"),
      FINALBOT_FAKE_AGENT: "1",
    });
    const runs = new RunService(db, bus, config);
    const app = createApp(db, bus, runs, () => [], null);

    try {
      append(db, bus, "history");
      const first = append(db, bus, "first");
      const second = append(db, bus, "second");
      const controller = new AbortController();
      const response = await app.request("/api/events", {
        headers: { "Last-Event-ID": String(first.seq) },
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      if (!reader) throw new Error("SSE response has no body");

      const replay = await readUntil(reader, `id: ${second.seq}`);
      expect(replay).toContain("second");
      expect(replay).not.toContain("first");
      expect(replay).not.toContain("history");

      const live = append(db, bus, "third");
      const update = await readUntil(reader, `id: ${live.seq}`);
      expect(update).toContain("third");
      controller.abort();
      await reader.cancel().catch(() => undefined);

      const freshController = new AbortController();
      const freshResponse = await app.request("/api/events", {
        signal: freshController.signal,
      });
      const freshReader = freshResponse.body?.getReader();
      if (!freshReader) throw new Error("Fresh SSE response has no body");
      const connected = await readUntil(freshReader, '"message":"connected"');
      expect(connected).not.toContain("history");
      const freshLive = append(db, bus, "fresh-live");
      const freshUpdate = await readUntil(freshReader, `id: ${freshLive.seq}`);
      expect(freshUpdate).toContain("fresh-live");
      freshController.abort();
      await freshReader.cancel().catch(() => undefined);
    } finally {
      await runs.close();
      db.close();
    }
  });
});

function append(db: FinalBotDatabase, bus: EventBus, message: string): { seq: number } {
  const event: ServerEvent = {
    type: "system",
    level: "info",
    message,
    at: new Date().toISOString(),
  };
  const record = db.appendEvent({ runId: null, type: event.type, payload: event });
  bus.publish({ seq: record.seq, event });
  return record;
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  marker: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let output = "";
  for (let count = 0; count < 10; count++) {
    const chunk = await reader.read();
    if (chunk.done) break;
    output += decoder.decode(chunk.value, { stream: true });
    if (output.includes(marker)) return output;
  }
  throw new Error(`Did not receive SSE marker: ${marker}`);
}
