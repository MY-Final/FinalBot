import type { FinalBotDatabase, ScheduleRecord } from "@finalbot/db";
import { Cron } from "croner";

export interface SchedulerOptions {
  db: FinalBotDatabase;
  defaultTimezone?: string;
  onDue(schedule: ScheduleRecord): Promise<void>;
}

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly options: SchedulerOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 1_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const due = this.options.db.listDueSchedules(now.toISOString());
      for (const schedule of due) {
        try {
          await this.options.onDue(schedule);
          this.options.db.updateSchedule(schedule.id, {
            lastRunAt: now.toISOString(),
            nextRunAt: this.nextRun(schedule, now),
            lastError: null,
          });
        } catch (error) {
          this.options.db.updateSchedule(schedule.id, {
            lastRunAt: now.toISOString(),
            nextRunAt: this.nextRun(schedule, now),
            lastError: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      this.running = false;
    }
  }

  nextRun(schedule: ScheduleRecord, from = new Date()): string | null {
    try {
      const cron = new Cron(schedule.expression, {
        timezone: schedule.timezone || this.options.defaultTimezone || "Asia/Shanghai",
      });
      return cron.nextRun(from)?.toISOString() ?? null;
    } catch {
      return null;
    }
  }

  validate(expression: string, timezone: string): void {
    new Cron(expression, { timezone });
  }
}
