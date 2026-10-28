import type {
  BotSummary,
  ChannelSummary,
  ConversationSummary,
  RunSummary,
  ScheduleSummary,
} from "@finalbot/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type CreateScheduleInput } from "./api";
import { EmptyState, formatDateTime, PageHeader, PanelNote, StatusDot, Tag, timeAgo } from "./ui";

export interface SchedulesPageProps {
  bots: BotSummary[];
  channels: ChannelSummary[];
  runs: RunSummary[];
  onError: (message: string | null) => void;
}

export function SchedulesPage({ bots, channels, runs, onError }: SchedulesPageProps) {
  const [schedules, setSchedules] = useState<ScheduleSummary[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [form, setForm] = useState<CreateScheduleInput>(emptyScheduleForm());
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    onError(null);
    try {
      const [nextSchedules, nextConversations] = await Promise.all([
        api.schedules(),
        api.conversations(),
      ]);
      setSchedules(nextSchedules);
      setConversations(nextConversations);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(): Promise<void> {
    if (saving) return;
    if (!form.name.trim() || !form.expression.trim() || !form.prompt.trim()) {
      onError("请填写名称、cron 表达式和任务内容。");
      return;
    }
    if (!form.conversationId.trim()) {
      onError("请选择一个已知对话作为计划目标。");
      return;
    }
    setSaving(true);
    onError(null);
    try {
      const created = await api.createSchedule({
        ...form,
        name: form.name.trim(),
        expression: form.expression.trim(),
        prompt: form.prompt.trim(),
        nextRunAt: new Date(form.nextRunAt).toISOString(),
      });
      setSchedules((current) => [created, ...current]);
      setForm(emptyScheduleForm());
      setOpen(false);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function toggle(schedule: ScheduleSummary): Promise<void> {
    onError(null);
    try {
      const updated = await api.toggleSchedule(schedule.id);
      setSchedules((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  const enabledCount = schedules.filter((schedule) => schedule.enabled).length;
  const proactiveChannels = useMemo(
    () => channels.filter((channel) => channel.capabilities.proactiveSend),
    [channels],
  );
  const conversationOptions = useMemo(() => {
    const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]));
    for (const run of runs) {
      if (!byId.has(run.conversationId)) {
        byId.set(run.conversationId, {
          id: run.conversationId,
          channel: "unknown",
          accountId: "unknown",
          externalId: run.conversationId,
          conversationKind: "private",
          title: null,
          activeBotId: run.botId,
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
          policy: {
            conversationId: run.conversationId,
            observeAll: false,
            discussEnabled: false,
            updatedAt: run.updatedAt,
          },
        });
      }
    }
    return [...byId.values()];
  }, [conversations, runs]);

  return (
    <main className="page-stage">
      <PageHeader
        eyebrow="Scheduler / durable cron"
        title="定时任务"
        description="计划持久化在 SQLite 中，默认使用 Asia/Shanghai。重启后逾期计划只合并补跑一次，不追补全部历史。"
        aside={
          <button
            type="button"
            className="dispatch-button"
            onClick={() => setOpen((value) => !value)}
          >
            {open ? "收起表单" : "创建计划"}
            <span aria-hidden="true">{open ? "−" : "+"}</span>
          </button>
        }
      />

      {open && (
        <section className="schedule-composer">
          <div className="form-grid">
            <label>
              名称
              <input
                value={form.name}
                onChange={(event) =>
                  setForm((current) => ({ ...current, name: event.target.value }))
                }
                placeholder="晨间代码巡检"
              />
            </label>
            <label>
              Cron
              <input
                value={form.expression}
                onChange={(event) =>
                  setForm((current) => ({ ...current, expression: event.target.value }))
                }
                placeholder="0 9 * * *"
              />
            </label>
            <label>
              时区
              <input
                value={form.timezone}
                onChange={(event) =>
                  setForm((current) => ({ ...current, timezone: event.target.value }))
                }
                placeholder="Asia/Shanghai"
              />
            </label>
            <label>
              Bot
              <select
                value={form.botId}
                onChange={(event) =>
                  setForm((current) => ({ ...current, botId: event.target.value }))
                }
              >
                {bots.map((bot) => (
                  <option value={bot.id} key={bot.id}>
                    {bot.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-span-2">
              Conversation ID
              <input
                list="schedule-conversation-options"
                value={form.conversationId}
                onChange={(event) =>
                  setForm((current) => ({ ...current, conversationId: event.target.value }))
                }
                placeholder="conv_xxx"
              />
              <datalist id="schedule-conversation-options">
                {conversationOptions.map((conversation) => (
                  <option
                    value={conversation.id}
                    key={conversation.id}
                    label={`${conversation.title || conversation.externalId} / ${conversation.channel}`}
                  />
                ))}
              </datalist>
            </label>
            <label className="form-span-2">
              首次触发时间
              <input
                type="datetime-local"
                value={toLocalInput(form.nextRunAt)}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    nextRunAt: new Date(event.target.value).toISOString(),
                  }))
                }
              />
            </label>
          </div>
          <label className="form-wide">
            任务内容
            <textarea
              value={form.prompt}
              onChange={(event) =>
                setForm((current) => ({ ...current, prompt: event.target.value }))
              }
              rows={4}
              placeholder="检查主分支测试失败项，生成原因分析和建议修复。"
            />
          </label>
          <div className="form-actions">
            <span>
              可主动发送的通道：
              {proactiveChannels.map((channel) => channel.type).join(" / ") || "暂无"}
            </span>
            <button
              type="button"
              className="dispatch-button"
              onClick={() => void create()}
              disabled={saving || bots.length === 0}
            >
              {saving ? "创建中" : "创建计划"}
            </button>
          </div>
        </section>
      )}

      <div className="metric-strip">
        <div>
          <span className="metric-value">{schedules.length}</span>
          <span className="metric-label">Schedules</span>
        </div>
        <div>
          <span className="metric-value">{enabledCount}</span>
          <span className="metric-label">Enabled</span>
        </div>
        <div>
          <span className="metric-value">
            {schedules.filter((schedule) => schedule.lastError).length}
          </span>
          <span className="metric-label">Errors</span>
        </div>
        <div className="metric-note">
          <StatusDot active={enabledCount > 0} label={loading ? "Refreshing" : "SQLite durable"} />
        </div>
      </div>

      <section className="schedule-list">
        {schedules.length === 0 ? (
          <EmptyState
            glyph="⌁"
            title="还没有定时任务"
            copy="创建一条 cron，让 FinalBot 在指定时区自动派发 Run。"
          />
        ) : (
          schedules.map((schedule, index) => {
            const lastRun = runs.find(
              (run) =>
                run.conversationId === schedule.conversationId && run.botId === schedule.botId,
            );
            return (
              <article
                className={`schedule-card ${schedule.enabled ? "" : "is-paused"}`}
                key={schedule.id}
                style={{ animationDelay: `${index * 50}ms` }}
              >
                <div className="schedule-clock">
                  <strong>{schedule.expression}</strong>
                  <span>{schedule.timezone}</span>
                </div>
                <div className="schedule-main">
                  <div className="schedule-title">
                    <h2>{schedule.name}</h2>
                    <Tag tone={schedule.enabled ? "success" : "neutral"}>
                      {schedule.enabled ? "enabled" : "paused"}
                    </Tag>
                  </div>
                  <p>{schedule.prompt}</p>
                  <dl className="schedule-meta">
                    <div>
                      <dt>NEXT</dt>
                      <dd>{formatDateTime(schedule.nextRunAt)}</dd>
                    </div>
                    <div>
                      <dt>LAST</dt>
                      <dd>{timeAgo(schedule.lastRunAt)}</dd>
                    </div>
                    <div>
                      <dt>BOT</dt>
                      <dd>{schedule.botId}</dd>
                    </div>
                    <div>
                      <dt>CONV</dt>
                      <dd title={schedule.conversationId}>{schedule.conversationId.slice(-12)}</dd>
                    </div>
                  </dl>
                  {schedule.lastError && (
                    <div className="inline-error">
                      <strong>Last run error</strong>
                      <span>{schedule.lastError}</span>
                    </div>
                  )}
                  {lastRun && (
                    <small className="schedule-link">
                      最近关联 Run {lastRun.id.slice(-8)} / {lastRun.state}
                    </small>
                  )}
                </div>
                <button
                  type="button"
                  className="schedule-toggle"
                  onClick={() => void toggle(schedule)}
                >
                  {schedule.enabled ? "暂停" : "恢复"}
                </button>
              </article>
            );
          })
        )}
      </section>

      <PanelNote title="创建计划的已知限制" tone="warning">
        计划目标来自已持久化会话列表。QQ 官方账号属于被动通道，执行时会拒绝主动发送； OneBot 与 Web
        可以主动投递。每条计划独立保存 IANA 时区。
      </PanelNote>
    </main>
  );
}

function toLocalInput(iso: string): string {
  const date = new Date(iso);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function emptyScheduleForm(): CreateScheduleInput {
  return {
    name: "",
    expression: "0 9 * * *",
    timezone: "Asia/Shanghai",
    conversationId: "",
    botId: "coder",
    prompt: "",
    nextRunAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  };
}
