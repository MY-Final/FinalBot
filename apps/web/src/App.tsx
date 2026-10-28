import type {
  BotSummary,
  ChannelSummary,
  HealthResponse,
  RunDetail,
  RunSummary,
  ServerEvent,
} from "@finalbot/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiRequestError, api, getAdminToken, setAdminToken, subscribeEvents } from "./api";
import { BotsPage } from "./BotsPage";
import { ChannelsPage } from "./ChannelsPage";
import { MemoryPage } from "./MemoryPage";
import { RunsPage } from "./RunsPage";
import { SchedulesPage } from "./SchedulesPage";
import { ToolsPage } from "./ToolsPage";

type PageId = "runs" | "channels" | "bots" | "memory" | "tools" | "schedules";

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

const NAV_ITEMS: Array<{
  id: PageId;
  label: string;
  index: string;
  description: string;
}> = [
  { id: "runs", label: "运行", index: "01", description: "Dispatch & inspect" },
  { id: "channels", label: "通道", index: "02", description: "Inbound / outbound" },
  { id: "bots", label: "Bots", index: "03", description: "Agent roster" },
  { id: "memory", label: "记忆", index: "04", description: "Owner / Bot layers" },
  { id: "tools", label: "工具", index: "05", description: "Tool snapshots" },
  { id: "schedules", label: "定时", index: "06", description: "Durable cron" },
];

export function App() {
  const [page, setPage] = useState<PageId>(() => pageFromHash());
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [liveOutput, setLiveOutput] = useState("");
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [navOpen, setNavOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [tokenDraft, setTokenDraft] = useState(getAdminToken());
  const [hasToken, setHasToken] = useState(Boolean(getAdminToken()));
  const [authInvalid, setAuthInvalid] = useState(false);
  const selectedIdRef = useRef<string | null>(null);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    const onHashChange = () => setPage(pageFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    const onUnauthorized = () => {
      setAuthOpen(true);
      setAuthInvalid(Boolean(getAdminToken()));
      setHasToken(false);
    };
    window.addEventListener("finalbot:unauthorized", onUnauthorized);
    return () => window.removeEventListener("finalbot:unauthorized", onUnauthorized);
  }, []);

  const refreshChannels = useCallback(async (): Promise<void> => {
    try {
      const next = await api.channels();
      setChannels(next);
      setHealth((current) => (current ? { ...current, channels: next } : current));
    } catch (cause) {
      handleApiError(cause, setError, setAuthOpen);
    }
  }, []);

  const bootstrap = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    const results = await Promise.allSettled([
      api.health(),
      api.bots(),
      api.channels(),
      api.runs(),
    ]);
    const [healthResult, botsResult, channelsResult, runsResult] = results;
    let unauthorized = false;
    if (healthResult.status === "fulfilled") {
      setHealth(healthResult.value);
    } else {
      unauthorized ||= handleApiError(healthResult.reason, setError, setAuthOpen);
    }
    if (botsResult.status === "fulfilled") {
      setBots(botsResult.value);
    } else {
      unauthorized ||= handleApiError(botsResult.reason, setError, setAuthOpen);
    }
    if (channelsResult.status === "fulfilled") {
      setChannels(channelsResult.value);
    } else {
      unauthorized ||= handleApiError(channelsResult.reason, setError, setAuthOpen);
    }
    if (runsResult.status === "fulfilled") {
      setRuns(runsResult.value);
      setSelectedId((current) => current ?? runsResult.value[0]?.id ?? null);
    } else {
      unauthorized ||= handleApiError(runsResult.reason, setError, setAuthOpen);
    }
    if (unauthorized) setAuthInvalid(Boolean(getAdminToken()));
    setLoading(false);
  }, []);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const applyEvent = useCallback((event: ServerEvent): void => {
    if (event.type === "run.updated") {
      setRuns((current) => {
        const index = current.findIndex((run) => run.id === event.run.id);
        const next = index >= 0 ? [...current] : [event.run, ...current];
        if (index >= 0) next[index] = event.run;
        return next.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      });
      if (event.run.id === selectedIdRef.current) {
        setDetail((current) => (current ? { ...current, ...event.run } : current));
      }
      return;
    }
    if (event.type === "run.delta" && event.runId === selectedIdRef.current) {
      setLiveOutput((current) => `${current}${event.text}`);
      return;
    }
    if (event.type === "approval.requested" || event.type === "approval.resolved") {
      if (event.approval.runId !== selectedIdRef.current) return;
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
  }, []);

  useEffect(() => {
    return subscribeEvents(applyEvent, setConnected, () => {
      setAuthOpen(true);
      setAuthInvalid(Boolean(getAdminToken()));
    });
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
        if (!cancelled) handleApiError(cause, setError, setAuthOpen);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const activeCount = useMemo(() => runs.filter((run) => !TERMINAL.has(run.state)).length, [runs]);
  const connectedChannels = channels.filter((channel) => channel.connected).length;

  function navigate(next: PageId): void {
    setPage(next);
    setNavOpen(false);
    window.history.replaceState(null, "", `#/${next}`);
  }

  async function createRun(prompt: string, botId: string): Promise<void> {
    setError(null);
    try {
      const run = await api.createRun(prompt, botId);
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
      setSelectedId(run.id);
    } catch (cause) {
      handleApiError(cause, setError, setAuthOpen);
      throw cause;
    }
  }

  async function interrupt(id: string): Promise<void> {
    try {
      await api.interrupt(id);
    } catch (cause) {
      handleApiError(cause, setError, setAuthOpen);
    }
  }

  async function resolveApproval(id: string, action: string): Promise<void> {
    try {
      await api.resolveApproval(id, action);
    } catch (cause) {
      handleApiError(cause, setError, setAuthOpen);
    }
  }

  function saveToken(): void {
    setAdminToken(tokenDraft);
    setHasToken(Boolean(tokenDraft.trim()));
    setAuthInvalid(false);
    setAuthOpen(false);
    void bootstrap();
  }

  function clearToken(): void {
    setAdminToken("");
    setTokenDraft("");
    setHasToken(false);
    setAuthInvalid(false);
    setAuthOpen(false);
    void bootstrap();
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <button
          type="button"
          className="wordmark"
          onClick={() => navigate("runs")}
          aria-label="FinalBot 首页"
        >
          <span className="wordmark-mark">F</span>
          <span>
            FINAL<span>BOT</span>
          </span>
        </button>

        <div className="topbar-center">
          <span className={`live-dot ${connected ? "is-live" : ""}`} />
          <span>{connected ? "事件流已连接" : "事件流重连中"}</span>
          <span className="topbar-rule" />
          <span>{activeCount} 个任务运行中</span>
        </div>

        <div className="topbar-meta">
          <button
            type="button"
            className={`connection-pill ${connectedChannels > 0 ? "ok" : ""}`}
            onClick={() => navigate("channels")}
          >
            <span className="pill-light" />
            Channels {connectedChannels}/{channels.length} 在线
          </button>
          <button
            type="button"
            className={`auth-button ${hasToken ? "is-authed" : ""} ${authInvalid ? "is-invalid" : ""}`}
            onClick={() => setAuthOpen(true)}
          >
            {authInvalid ? "Token 无效" : hasToken ? "Admin" : "Auth"}
          </button>
          <span className="clock">OPS / 001</span>
          <button
            type="button"
            className={`menu-toggle ${navOpen ? "is-open" : ""}`}
            onClick={() => setNavOpen((open) => !open)}
            aria-label="打开导航"
            aria-expanded={navOpen}
          >
            <i />
            <i />
          </button>
        </div>
      </header>

      <nav className={`side-nav ${navOpen ? "is-open" : ""}`} aria-label="主导航">
        <div className="nav-caption">CONTROL PLANE</div>
        {NAV_ITEMS.map((item) => (
          <button
            type="button"
            key={item.id}
            className={page === item.id ? "is-active" : ""}
            onClick={() => navigate(item.id)}
          >
            <span className="nav-index">{item.index}</span>
            <span className="nav-label">
              <strong>{item.label}</strong>
              <small>{item.description}</small>
            </span>
            <span className="nav-arrow">↗</span>
          </button>
        ))}
        <div className="nav-foot">
          <span className={`live-dot ${connected ? "is-live" : ""}`} />
          <span>{health ? `UPTIME ${formatUptime(health.uptimeSeconds)}` : "CONNECTING"}</span>
        </div>
      </nav>

      <div className={`page-area ${page === "runs" ? "is-runs" : ""}`}>
        {page === "runs" && (
          <RunsPage
            runs={runs}
            bots={bots}
            selectedId={selectedId}
            detail={detail}
            liveOutput={liveOutput}
            error={error}
            onSelect={setSelectedId}
            onCreateRun={createRun}
            onInterrupt={interrupt}
            onResolveApproval={resolveApproval}
            onClearError={() => setError(null)}
          />
        )}
        {page === "channels" && (
          <ChannelsPage
            channels={channels}
            loading={loading}
            onRefresh={refreshChannels}
            onError={setError}
          />
        )}
        {page === "bots" && <BotsPage bots={bots} runs={runs} />}
        {page === "memory" && <MemoryPage bots={bots} onError={setError} />}
        {page === "tools" && <ToolsPage onError={setError} />}
        {page === "schedules" && (
          <SchedulesPage bots={bots} channels={channels} runs={runs} onError={setError} />
        )}
      </div>

      <footer className="footer-line">
        <span>FINALBOT / PERSONAL AGENT CONTROL PLANE</span>
        <span>{page.toUpperCase()} / TS + BUN / LOCAL FIRST</span>
      </footer>

      {error && page !== "runs" && (
        <div className="global-error" role="alert">
          <strong>操作失败</strong>
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)}>
            关闭
          </button>
        </div>
      )}

      {authOpen && (
        <div className="dialog-backdrop" role="presentation">
          <section
            className="auth-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="auth-title"
          >
            <div className="auth-dialog-head">
              <div>
                <p className="eyebrow">Gateway authentication</p>
                <h2 id="auth-title">管理员 Token</h2>
              </div>
              <button type="button" className="dialog-close" onClick={() => setAuthOpen(false)}>
                ×
              </button>
            </div>
            <p>
              非回环监听时必须携带 <code>Bearer FINALBOT_ADMIN_TOKEN</code>。Token
              只保存在当前标签页的 <code>sessionStorage</code>，关闭标签页后清除。
            </p>
            {authInvalid && (
              <div className="inline-error">
                <strong>认证失败</strong>
                <span>Token 缺失或已失效，请重新输入。</span>
              </div>
            )}
            <label className="token-field">
              Admin token
              <input
                type="password"
                value={tokenDraft}
                onChange={(event) => setTokenDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") saveToken();
                }}
                autoComplete="off"
                placeholder="输入服务端 FINALBOT_ADMIN_TOKEN"
              />
            </label>
            <div className="auth-actions">
              {hasToken && (
                <button type="button" className="quiet-button" onClick={clearToken}>
                  清除 Token
                </button>
              )}
              <button type="button" className="dispatch-button" onClick={saveToken}>
                保存并重连
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function pageFromHash(): PageId {
  const value = window.location.hash.replace(/^#\/?/, "");
  return NAV_ITEMS.some((item) => item.id === value) ? (value as PageId) : "runs";
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

function handleApiError(
  cause: unknown,
  setError: (message: string | null) => void,
  setAuthOpen: (open: boolean) => void,
): boolean {
  if (cause instanceof ApiRequestError && cause.status === 401) {
    setAuthOpen(true);
    setError(null);
    return true;
  }
  setError(cause instanceof Error ? cause.message : String(cause));
  return false;
}
