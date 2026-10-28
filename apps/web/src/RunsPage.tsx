import type { ApprovalSummary, BotSummary, RunDetail, RunSummary } from "@finalbot/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { shorten, timeAgo } from "./ui";

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

export interface RunsPageProps {
  runs: RunSummary[];
  bots: BotSummary[];
  selectedId: string | null;
  detail: RunDetail | null;
  liveOutput: string;
  error: string | null;
  onSelect: (id: string) => void;
  onCreateRun: (prompt: string, botId: string) => Promise<void>;
  onInterrupt: (id: string) => Promise<void>;
  onResolveApproval: (id: string, action: string) => Promise<void>;
  onClearError: () => void;
}

export function RunsPage({
  runs,
  bots,
  selectedId,
  detail,
  liveOutput,
  error,
  onSelect,
  onCreateRun,
  onInterrupt,
  onResolveApproval,
  onClearError,
}: RunsPageProps) {
  const [selectedBotId, setSelectedBotId] = useState("coder");
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (bots.some((bot) => bot.id === selectedBotId)) return;
    setSelectedBotId(bots[0]?.id ?? "coder");
  }, [bots, selectedBotId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: output changes intentionally trigger scrolling.
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

  async function submit(): Promise<void> {
    const value = prompt.trim();
    if (!value || submitting) return;
    setSubmitting(true);
    try {
      await onCreateRun(value, selectedBotId);
      setPrompt("");
    } catch {
      // App owns the API error banner; keep the draft for a retry.
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="runs-page">
      <aside className="run-rail">
        <div className="rail-heading">
          <div>
            <p className="eyebrow">Dispatch queue</p>
            <h1>运行记录</h1>
          </div>
          <span className="count-badge">{runs.length.toString().padStart(2, "0")}</span>
        </div>

        {error && (
          <div className="rail-error" role="alert">
            <span>{error}</span>
            <button type="button" onClick={onClearError}>
              关闭
            </button>
          </div>
        )}

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
              disabled={submitting || bots.length === 0}
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
                onClick={() => onSelect(run.id)}
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
                  <button
                    type="button"
                    className="quiet-button"
                    onClick={() => void onInterrupt(selected.id)}
                  >
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
                    <button type="button" onClick={onClearError}>
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
                    隔离工作区
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
                        onResolve={onResolveApproval}
                      />
                    ))
                  )}
                </div>

                <div className="inspector-section">
                  <p className="eyebrow">Messages</p>
                  {detail?.messages.length ? (
                    detail.messages.slice(-4).map((message) => (
                      <div className="message-row" key={message.id}>
                        <span>{message.role}</span>
                        <p>{shorten(message.text, 160)}</p>
                      </div>
                    ))
                  ) : (
                    <p className="muted-copy">没有关联消息。</p>
                  )}
                </div>

                <div className="inspector-section">
                  <p className="eyebrow">Tool calls</p>
                  {detail?.toolCalls.length ? (
                    detail.toolCalls.slice(-5).map((call) => (
                      <div className="tool-call-row" key={call.id}>
                        <strong>
                          {call.namespace}/{call.tool}
                        </strong>
                        <span className={`call-status call-${call.status}`}>{call.status}</span>
                      </div>
                    ))
                  ) : (
                    <p className="muted-copy">本 Run 尚未调用工具。</p>
                  )}
                </div>

                <div className="inspector-section">
                  <p className="eyebrow">Discuss</p>
                  {detail?.discussDecisions.length ? (
                    detail.discussDecisions.slice(0, 3).map((decision) => (
                      <div className="message-row" key={decision.id}>
                        <span>{decision.action}</span>
                        <p>{decision.reason}</p>
                      </div>
                    ))
                  ) : (
                    <p className="muted-copy">没有 Discuss 决策。</p>
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
