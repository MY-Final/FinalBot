import type {
  ApprovalSummary,
  BotSummary,
  HealthResponse,
  RunDetail,
  RunSummary,
  ServerEvent,
} from "@finalbot/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, subscribeEvents } from "./api";

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

const STATE_LABEL: Record<string, string> = {
  admitted: "已接收",
  running: "执行中",
  waiting_approval: "等待审批",
  retrying: "重试中",
  interrupted: "已中断",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

function timeAgo(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 10) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return new Date(iso).toLocaleDateString("zh-CN");
}

function shorten(value: string, max = 72): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max)}...` : compact;
}

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [selectedBotId, setSelectedBotId] = useState("coder");
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [liveOutput, setLiveOutput] = useState("");
  const [prompt, setPrompt] = useState("");
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    void api
      .health()
      .then(setHealth)
      .catch((cause: unknown) => setError(String(cause)));
    void api
      .runs()
      .then((items) => {
        setRuns(items);
        setSelectedId((current) => current ?? items[0]?.id ?? null);
      })
      .catch((cause: unknown) => setError(String(cause)));
    void api
      .bots()
      .then((items) => {
        setBots(items);
        setSelectedBotId((current) =>
          items.some((bot) => bot.id === current) ? current : (items[0]?.id ?? "coder"),
        );
      })
      .catch((cause: unknown) => setError(String(cause)));
  }, []);

  const applyEvent = useCallback(
    (event: ServerEvent): void => {
      if (event.type === "run.updated") {
        setRuns((current) => {
          const index = current.findIndex((run) => run.id === event.run.id);
          const next = index >= 0 ? [...current] : [event.run, ...current];
          if (index >= 0) next[index] = event.run;
          return next.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        });
        if (event.run.id === selectedId) {
          setDetail((current) => (current ? { ...current, ...event.run } : current));
        }
        return;
      }
      if (event.type === "run.delta" && event.runId === selectedId) {
        setLiveOutput((current) => `${current}${event.text}`);
        return;
      }
      if (event.type === "approval.requested" || event.type === "approval.resolved") {
        if (event.approval.runId !== selectedId) return;
        setDetail((current) => {
          if (!current) return current;
          const approvals = current.approvals.filter(
            (item) => item.requestId !== event.approval.requestId,
          );
          approvals.push(event.approval);
          return { ...current, approvals };
        });
        return;
      }
      if (event.type === "system" && event.level !== "info") {
        setError(event.message);
      }
    },
    [selectedId],
  );

  useEffect(() => {
    return subscribeEvents(applyEvent, setConnected);
  }, [applyEvent]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setLiveOutput("");
      return;
    }
    let cancelled = false;
    void api
      .run(selectedId)
      .then((next) => {
        if (cancelled) return;
        setDetail(next);
        setLiveOutput(next.output);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: liveOutput intentionally triggers scrolling.
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [liveOutput]);

  const pendingApprovals = useMemo(
    () => detail?.approvals.filter((approval) => approval.status === "pending") ?? [],
    [detail],
  );
  const selected = runs.find((run) => run.id === selectedId) ?? detail ?? null;
  const activeCount = runs.filter((run) => !TERMINAL.has(run.state)).length;

  async function submit(): Promise<void> {
    const value = prompt.trim();
    if (!value || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const run = await api.createRun(value, selectedBotId);
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
      setSelectedId(run.id);
      setPrompt("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  }

  async function interrupt(): Promise<void> {
    if (!selectedId) return;
    try {
      await api.interrupt(selectedId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function resolveApproval(requestId: string, action: string): Promise<void> {
    try {
      await api.resolveApproval(requestId, action);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="wordmark" href="/" aria-label="FinalBot">
          <span className="wordmark-mark">F</span>
          <span>
            FINAL<span>BOT</span>
          </span>
        </a>
        <div className="topbar-center">
          <span className={`live-dot ${connected ? "is-live" : ""}`} />
          <span>{connected ? "事件流已连接" : "事件流重连中"}</span>
          <span className="topbar-rule" />
          <span>{activeCount} 个任务运行中</span>
        </div>
        <div className="topbar-meta">
          <span className={`connection-pill ${health?.onebot.connected ? "ok" : ""}`}>
            <span className="pill-light" />
            NapCat {health?.onebot.connected ? "在线" : "未连接"}
          </span>
          <span className="clock">OPS / 001</span>
        </div>
      </header>

      <main className="dispatch-grid">
        <aside className="run-rail">
          <div className="rail-heading">
            <div>
              <p className="eyebrow">Dispatch queue</p>
              <h1>运行记录</h1>
            </div>
            <span className="count-badge">{runs.length.toString().padStart(2, "0")}</span>
          </div>

          <div className="composer">
            <label htmlFor="new-run">派发新任务</label>
            <fieldset className="bot-picker" aria-label="选择 Bot">
              {bots.map((bot) => (
                <button
                  type="button"
                  key={bot.id}
                  className={bot.id === selectedBotId ? "is-active" : ""}
                  onClick={() => setSelectedBotId(bot.id)}
                  title={bot.description}
                >
                  {bot.name}
                </button>
              ))}
            </fieldset>
            <textarea
              id="new-run"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  void submit();
                }
              }}
              placeholder="例如：检查登录流程，修复失败测试并给出变更摘要。"
              rows={4}
            />
            <div className="composer-footer">
              <span>
                <kbd>Ctrl</kbd> <b>+</b> <kbd>Enter</kbd>
              </span>
              <button
                type="button"
                className="dispatch-button"
                onClick={() => void submit()}
                disabled={submitting}
              >
                {submitting ? "派发中" : "开始派发"}
                <span aria-hidden="true">↗</span>
              </button>
            </div>
          </div>

          <div className="run-list">
            {runs.length === 0 ? (
              <div className="empty-queue">
                <span className="empty-glyph">∅</span>
                <p>还没有任务</p>
                <small>派发一个任务，FinalBot 会替你点将。</small>
              </div>
            ) : (
              runs.map((run, index) => (
                <button
                  type="button"
                  key={run.id}
                  className={`run-card ${run.id === selectedId ? "is-selected" : ""}`}
                  onClick={() => setSelectedId(run.id)}
                  style={{ animationDelay: `${index * 35}ms` }}
                >
                  <div className="run-card-top">
                    <span className={`state state-${run.state}`}>
                      {STATE_LABEL[run.state] ?? run.state}
                    </span>
                    <span className="run-time">{timeAgo(run.createdAt)}</span>
                  </div>
                  <strong>{shorten(run.prompt, 56)}</strong>
                  <div className="run-card-bottom">
                    <span>
                      {run.botName} / {run.agent}
                    </span>
                    <span className="run-id">{run.id.slice(-8)}</span>
                  </div>
                </button>
              ))
            )}
          </div>
        </aside>

        <section className="workbench">
          {!selected ? (
            <div className="idle-stage">
              <div className="orbital" aria-hidden="true">
                <div className="orbit orbit-one" />
                <div className="orbit orbit-two" />
                <div className="orbit orbit-three" />
                <div className="core-mark">F</div>
              </div>
              <p className="eyebrow">FinalBot command plane</p>
              <h2>一句话，点齐你的 Agent。</h2>
              <p className="idle-copy">
                从一个任务开始。FinalBot 会创建隔离工作区、启动 Coding Agent，
                把每一步执行、审批和结果留在这里。
              </p>
            </div>
          ) : (
            <>
              <div className="workbench-head">
                <div>
                  <div className="breadcrumb">
                    RUN / {selected.id.slice(-8).toUpperCase()} / {selected.botName.toUpperCase()}
                  </div>
                  <h2>{shorten(selected.prompt, 110)}</h2>
                </div>
                <div className="workbench-actions">
                  <span className={`large-state state-${selected.state}`}>
                    {STATE_LABEL[selected.state] ?? selected.state}
                  </span>
                  {!TERMINAL.has(selected.state) && (
                    <button type="button" className="quiet-button" onClick={() => void interrupt()}>
                      中断任务
                    </button>
                  )}
                </div>
              </div>

              <div className="workbench-grid">
                <div className="console-panel">
                  <div className="panel-label">
                    <span>Agent stream</span>
                    <span className="stream-status">
                      <i className={selected.state === "running" ? "pulse" : ""} />
                      {selected.state === "running" ? "LIVE" : "SNAPSHOT"}
                    </span>
                  </div>
                  <div className="terminal-head">
                    <span className="terminal-dot red" />
                    <span className="terminal-dot amber" />
                    <span className="terminal-dot green" />
                    <span>finalbot://{selected.agent}/dispatch</span>
                  </div>
                  <pre className="agent-output" ref={outputRef}>
                    {liveOutput || "等待 Agent 输出..."}
                  </pre>
                  {error && (
                    <div className="error-banner">
                      <strong>连接错误</strong>
                      <span>{error}</span>
                      <button type="button" onClick={() => setError(null)}>
                        关闭
                      </button>
                    </div>
                  )}
                </div>

                <aside className="inspector">
                  <div className="inspector-section">
                    <p className="eyebrow">Run control</p>
                    <dl className="meta-list">
                      <div>
                        <dt>状态</dt>
                        <dd>{STATE_LABEL[selected.state] ?? selected.state}</dd>
                      </div>
                      <div>
                        <dt>Bot</dt>
                        <dd>{selected.botName}</dd>
                      </div>
                      <div>
                        <dt>Agent</dt>
                        <dd>{selected.agent}</dd>
                      </div>
                      <div>
                        <dt>模型</dt>
                        <dd>{selected.model ?? "默认模型"}</dd>
                      </div>
                      <div>
                        <dt>开始</dt>
                        <dd>{selected.startedAt ? timeAgo(selected.startedAt) : "等待"}</dd>
                      </div>
                      <div>
                        <dt>线程</dt>
                        <dd title={selected.nativeThreadId ?? ""}>
                          {selected.nativeThreadId?.slice(-12) ?? "待绑定"}
                        </dd>
                      </div>
                    </dl>
                  </div>

                  <div className="inspector-section workspace-section">
                    <p className="eyebrow">Workspace</p>
                    <p className="path">{selected.workspacePath ?? "尚未创建工作区"}</p>
                    <div className="workspace-badge">
                      <span className="branch-icon">⌘</span>
                      隔离 Git worktree
                    </div>
                  </div>

                  <div className="inspector-section">
                    <div className="section-title-row">
                      <p className="eyebrow">Approvals</p>
                      <span className="mini-count">{pendingApprovals.length}</span>
                    </div>
                    {pendingApprovals.length === 0 ? (
                      <p className="muted-copy">当前没有待审批操作。</p>
                    ) : (
                      pendingApprovals.map((approval) => (
                        <ApprovalCard
                          key={approval.requestId}
                          approval={approval}
                          onResolve={resolveApproval}
                        />
                      ))
                    )}
                  </div>

                  <div className="inspector-section phases">
                    <p className="eyebrow">Checkpoints</p>
                    {detail?.phases.length ? (
                      detail.phases.map((phase) => (
                        <div key={`${phase.phase}-${phase.attempt}`} className="phase-row">
                          <span className={`phase-mark phase-${phase.status}`} />
                          <div>
                            <strong>{phase.phase}</strong>
                            <small>
                              {phase.status} / attempt {phase.attempt}
                            </small>
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="muted-copy">首个 checkpoint 将在执行后出现。</p>
                    )}
                  </div>
                </aside>
              </div>
            </>
          )}
        </section>
      </main>
      <footer className="footer-line">
        <span>FINALBOT / PERSONAL AGENT CONTROL PLANE</span>
        <span>TS + BUN / LOCAL FIRST</span>
      </footer>
    </div>
  );
}

function ApprovalCard({
  approval,
  onResolve,
}: {
  approval: ApprovalSummary;
  onResolve: (id: string, action: string) => Promise<void>;
}) {
  return (
    <div className="approval-card">
      <span className="approval-kind">{approval.kind.replaceAll("_", " ")}</span>
      <strong>{approval.title}</strong>
      <p>{approval.detail}</p>
      <div className="approval-actions">
        <button
          type="button"
          className="approve"
          onClick={() => void onResolve(approval.requestId, "accept")}
        >
          允许本次
        </button>
        {approval.canAcceptForSession && (
          <button
            type="button"
            className="approve"
            onClick={() => void onResolve(approval.requestId, "accept_session")}
          >
            本会话允许
          </button>
        )}
        <button type="button" onClick={() => void onResolve(approval.requestId, "decline")}>
          拒绝
        </button>
        <button
          type="button"
          className="cancel-action"
          onClick={() => void onResolve(approval.requestId, "cancel")}
        >
          取消
        </button>
      </div>
    </div>
  );
}
