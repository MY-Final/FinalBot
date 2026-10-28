import type { PluginSummary } from "@finalbot/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type PluginMutationResponse } from "./api";
import { EmptyState, PageHeader, PanelNote, Tag, timeAgo } from "./ui";

export function PluginsPage({ onError }: { onError: (message: string | null) => void }) {
  const [plugins, setPlugins] = useState<PluginSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    onError(null);
    try {
      setPlugins(await api.plugins());
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function mutate(
    key: string,
    operation: () => Promise<PluginMutationResponse>,
  ): Promise<void> {
    if (busy) return;
    setBusy(key);
    onError(null);
    try {
      const result = await operation();
      setPlugins(result.plugins);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
      try {
        setPlugins(await api.plugins());
      } catch {
        // Keep the previous view; the primary operation error is more useful.
      }
    } finally {
      setBusy(null);
    }
  }

  async function enable(plugin: PluginSummary): Promise<void> {
    const confirmed = window.confirm(
      `启用 ${plugin.name}@${plugin.version} 会在隔离 Worker 中执行其代码，并加入新 Run 的工具快照。继续？`,
    );
    if (!confirmed) return;
    await mutate(`enable:${plugin.id}`, () => api.enablePlugin(plugin.id));
  }

  async function disable(plugin: PluginSummary): Promise<void> {
    await mutate(`disable:${plugin.id}`, () => api.disablePlugin(plugin.id));
  }

  async function reload(plugin: PluginSummary): Promise<void> {
    await mutate(`reload:${plugin.id}`, () => api.reloadPlugin(plugin.id));
  }

  async function reloadAll(): Promise<void> {
    await mutate("reload:all", () => api.reloadPlugins());
  }

  async function setPolicy(
    plugin: PluginSummary,
    toolName: string,
    policy: "auto" | "ask" | "deny",
  ): Promise<void> {
    await mutate(`policy:${plugin.id}:${toolName}`, () =>
      api.updatePluginPolicy(plugin.id, toolName, policy),
    );
  }

  const counts = useMemo(() => {
    return plugins.reduce(
      (result, plugin) => {
        result.tools += plugin.tools.length;
        result.events += plugin.events.length;
        if (plugin.status === "active") result.active += 1;
        if (plugin.status === "error" || plugin.status === "missing") result.errors += 1;
        return result;
      },
      { active: 0, tools: 0, events: 0, errors: 0 },
    );
  }, [plugins]);

  return (
    <main className="page-stage">
      <PageHeader
        eyebrow="Plugin SDK / worker isolation"
        title="插件"
        description="插件可以注册动态工具和事件处理器。启用状态持久化在 SQLite，工具加入不可变 ToolSnapshot，只影响之后创建的 Run。"
        aside={
          <div className="header-actions">
            <button
              type="button"
              className="outline-button"
              onClick={() => void load()}
              disabled={loading || busy !== null}
            >
              {loading ? "刷新中" : "刷新"}
            </button>
            <button
              type="button"
              className="dispatch-button"
              onClick={() => void reloadAll()}
              disabled={busy !== null}
            >
              {busy === "reload:all" ? "发现中" : "重新发现"}
              <span aria-hidden="true">↻</span>
            </button>
          </div>
        }
      />

      <div className="metric-strip">
        <div>
          <span className="metric-value">{plugins.length.toString().padStart(2, "0")}</span>
          <span className="metric-label">Discovered</span>
        </div>
        <div>
          <span className="metric-value">{counts.active.toString().padStart(2, "0")}</span>
          <span className="metric-label">Active</span>
        </div>
        <div>
          <span className="metric-value">{counts.tools.toString().padStart(2, "0")}</span>
          <span className="metric-label">Tools</span>
        </div>
        <div className="metric-note">
          <Tag tone={counts.errors > 0 ? "danger" : "success"}>
            {counts.errors > 0 ? `${counts.errors} failed` : "registry healthy"}
          </Tag>
        </div>
      </div>

      <section className="plugin-grid">
        {plugins.length === 0 ? (
          <EmptyState
            glyph="⌘"
            title={loading ? "正在扫描插件目录" : "还没有发现插件"}
            copy="将插件放到 data/plugins/<plugin-id>/，并提供 metadata.json 与入口文件，然后点击重新发现。"
          />
        ) : (
          plugins.map((plugin, index) => (
            <article
              className={`plugin-card plugin-status-${plugin.status}`}
              key={plugin.id}
              style={{ animationDelay: `${index * 45}ms` }}
            >
              <header className="plugin-card-head">
                <span className="plugin-mark" aria-hidden="true">
                  {plugin.name.slice(0, 1).toUpperCase()}
                </span>
                <div className="plugin-identity">
                  <div className="schedule-title">
                    <h2>{plugin.name}</h2>
                    <Tag tone={statusTone(plugin.status)}>{plugin.status}</Tag>
                  </div>
                  <p className="eyebrow">
                    {plugin.id}@{plugin.version} / {plugin.source}
                  </p>
                </div>
                <div className="plugin-actions">
                  <button
                    type="button"
                    className="quiet-button"
                    onClick={() => void reload(plugin)}
                    disabled={busy !== null}
                  >
                    {busy === `reload:${plugin.id}` ? "重载中" : "重载"}
                  </button>
                  {plugin.enabled ? (
                    <button
                      type="button"
                      className="quiet-button danger-text"
                      onClick={() => void disable(plugin)}
                      disabled={busy !== null}
                    >
                      {busy === `disable:${plugin.id}` ? "停用中" : "停用"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="outline-button"
                      onClick={() => void enable(plugin)}
                      disabled={busy !== null}
                    >
                      {busy === `enable:${plugin.id}` ? "启动中" : "启用"}
                    </button>
                  )}
                </div>
              </header>

              <div className="plugin-card-body">
                <p className="plugin-description">{plugin.description}</p>
                <dl className="plugin-facts">
                  <div>
                    <dt>Author</dt>
                    <dd>{plugin.author || "未声明"}</dd>
                  </div>
                  <div>
                    <dt>API</dt>
                    <dd>v1 / {plugin.enabled ? "enabled" : "disabled"}</dd>
                  </div>
                  <div>
                    <dt>Updated</dt>
                    <dd>{timeAgo(plugin.updatedAt)}</dd>
                  </div>
                </dl>

                <div className="plugin-section-head">
                  <span>Tools</span>
                  <b>{plugin.tools.length}</b>
                </div>
                {plugin.tools.length === 0 ? (
                  <p className="plugin-empty-copy">
                    {plugin.status === "disabled"
                      ? "启用插件后会注册声明的工具。"
                      : "当前没有已加载工具。"}
                  </p>
                ) : (
                  <div className="plugin-tool-list">
                    {plugin.tools.map((tool) => (
                      <div className="tool-row" key={tool.name}>
                        <div>
                          <strong>{tool.name}</strong>
                          <p>{tool.description || "无描述"}</p>
                        </div>
                        <select
                          className="policy-select"
                          aria-label={`${tool.name} 工具策略`}
                          value={tool.policy}
                          disabled={busy !== null}
                          onChange={(event) =>
                            void setPolicy(
                              plugin,
                              tool.name,
                              event.target.value as "auto" | "ask" | "deny",
                            )
                          }
                        >
                          <option value="auto">auto</option>
                          <option value="ask">ask</option>
                          <option value="deny">deny</option>
                        </select>
                      </div>
                    ))}
                  </div>
                )}

                <div className="plugin-section-head">
                  <span>Events</span>
                  <b>{plugin.events.length}</b>
                </div>
                <div className="plugin-event-list">
                  {plugin.events.length === 0 ? (
                    <span className="plugin-empty-copy">未订阅事件</span>
                  ) : (
                    plugin.events.map((event) => (
                      <Tag tone="sea" key={event}>
                        {event}
                      </Tag>
                    ))
                  )}
                </div>

                {plugin.lastError && (
                  <div className="inline-error">
                    <strong>Last error</strong>
                    <span>{plugin.lastError}</span>
                  </div>
                )}
              </div>
            </article>
          ))
        )}
      </section>

      <PanelNote title="部署边界" tone="warning">
        扫描目录是 data/plugins，插件可用私有目录 data/plugin-data/&lt;id&gt;。Worker
        会隔离崩溃、超时和主进程环境变量，但 Node/Bun Worker
        不是恶意代码的强安全边界；只启用你信任的插件。
        当前版本只支持本地插件，不包含在线安装、签名或权限市场。
      </PanelNote>
    </main>
  );
}

function statusTone(
  status: PluginSummary["status"],
): "neutral" | "sea" | "success" | "warning" | "danger" {
  if (status === "active") return "success";
  if (status === "loading") return "sea";
  if (status === "error" || status === "missing") return "danger";
  if (status === "disabled") return "warning";
  return "neutral";
}
