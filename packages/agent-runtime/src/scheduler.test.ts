import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FinalBotDatabase, type ScheduleRecord } from "@finalbot/db";
import { Scheduler } from "./scheduler";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("scheduler", () => {
  test("runs an overdue schedule once and advances it in its IANA timezone", async () => {
    const db = await createDb();
    try {
      const conversation = db.upsertConversation({
        channel: "web",
        accountId: "local",
        externalId: "schedule",
        conversationKind: "private",
      });
      const schedule = db.createSchedule({
        id: "schedule-1",
        name: "Morning review",
        expression: "0 9 * * *",
        timezone: "Asia/Shanghai",
        conversationId: conversation.id,
        botId: "coder",
        prompt: "review the repository",
        nextRunAt: "2026-01-01T00:00:00.000Z",
      });
      const calls: ScheduleRecord[] = [];
      const scheduler = new Scheduler({
        db,
        async onDue(item) {
          calls.push(item);
        },
      });
      const now = new Date("2026-01-02T00:00:00.000Z");

      await scheduler.tick(now);
      await scheduler.tick(now);

      expect(calls.map((item) => item.id)).toEqual([schedule.id]);
      expect(db.getSchedule(schedule.id)).toMatchObject({
        lastRunAt: now.toISOString(),
        nextRunAt: "2026-01-02T01:00:00.000Z",
        lastError: null,
      });
    } finally {
      db.close();
    }
  });

  test("supports per-schedule timezones and records failures", async () => {
    const db = await createDb();
    try {
      const conversation = db.upsertConversation({
        channel: "web",
        accountId: "local",
        externalId: "schedule-failure",
        conversationKind: "private",
      });
      const schedule = db.createSchedule({
        id: "schedule-2",
        name: "Broken task",
        expression: "0 9 * * *",
        timezone: "America/New_York",
        conversationId: conversation.id,
        botId: "coder",
        prompt: "fail",
        nextRunAt: "2026-01-02T13:00:00.000Z",
      });
      const scheduler = new Scheduler({
        db,
        async onDue() {
          throw new Error("agent unavailable");
        },
      });
      const now = new Date("2026-01-02T12:00:00.000Z");

      expect(scheduler.nextRun(schedule, now)).toBe("2026-01-02T14:00:00.000Z");
      await scheduler.tick(new Date("2026-01-02T14:30:00.000Z"));
      expect(db.getSchedule(schedule.id)).toMatchObject({
        lastRunAt: "2026-01-02T14:30:00.000Z",
        nextRunAt: "2026-01-03T14:00:00.000Z",
        lastError: "agent unavailable",
      });
      expect(() => scheduler.validate("not a cron", "UTC")).toThrow();
    } finally {
      db.close();
    }
  });
});

async function createDb(): Promise<FinalBotDatabase> {
  const dir = await mkdtemp(join(tmpdir(), "finalbot-scheduler-"));
  dirs.push(dir);
  return new FinalBotDatabase(join(dir, "test.sqlite"));
}
