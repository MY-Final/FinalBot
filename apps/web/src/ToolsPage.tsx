import type { McpServerSummary } from "@finalbot/protocol";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { api, type CreateMcpServerInput, type ToolSnapshotResponse } from "./api";
import { EmptyState, PageHeader, PanelNote, StatusDot, Tag, timeAgo } from "./ui";

export function ToolsPage({ onError }: { onError: (message: string | null) => void }) {
  const [snapshot, setSnapshot] = useState<ToolSnapshotResponse | null>(null);
  const [servers, setServers] = useState<McpServerSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [filter, setFilter] = useState<"all" | "auto" | "ask" | "deny">("all");
  const [query, setQuery] = useState("");
  const [serverOpen, setServerOpen] = useState(false);
  const [serverForm, setServerForm] = useState<McpServerForm>(emptyServerForm());

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    onError(null);
    try {
      const [nextSnapshot, nextServers] = await Promise.all([api.tools(), api.mcpServers()]);
      setSnapshot(nextSnapshot);
      setServers(nextServers);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function reload(): Promise<void> {
    setReloading(true);
    onError(null);
    try {
      const result = await api.reloadMcp();
      const nextSnapshot = await api.tools();
      setSnapshot(nextSnapshot);
      setServers(result.servers);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setReloading(false);
    }
  }

  async function saveServer(): Promise<void> {
    onError(null);
    try {
      const input = serverInput(serverForm);
      const saved = await api.saveMcpServer(input);
      setServers((current) => [saved, ...current.filter((server) => server.id !== saved.id)]);
      setServerOpen(false);
      setServerForm(emptyServerForm());
      await reload();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  async function removeServer(server: McpServerSummary): Promise<void> {
    if (!window.confirm(`移除 MCP server ${server.name}？当前 Run 的工具快照不会被改写。`)) {
      return;
    }
    onError(null);
    try {
      await api.deleteMcpServer(server.id);
      await load();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  async function setPolicy(
    server: McpServerSummary,
    toolName: string,
    policy: "auto" | "ask" | "deny",
  ): Promise<void> {
    onError(null);
    try {
      setSnapshot(await api.updateMcpPolicy(server.id, toolName, policy));
      setServers((current) =>
        current.map((item) =>
          item.id === server.id
            ? {
                ...item,
                tools: item.tools.map((tool) =>
                  tool.name === toolName ? { ...tool, policy } : tool,
                ),
              }
            : item,
        ),
      );
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  const namespaces = useMemo(() => {
    const groups = new Map<string, ToolSnapshotResponse["tools"]>();
    const term = query.trim().toLowerCase();
    for (const tool of snapshot?.tools ?? []) {
      if (filter !== "all" && tool.policy !== filter) continue;
      if (
        term &&
        !`${tool.namespace} ${tool.name} ${tool.description}`.toLowerCase().includes(term)
      ) {
        continue;
      }
      const list = groups.get(tool.namespace) ?? [];
      list.push(tool);
      groups.set(tool.namespace, list);
    }
    return [...groups.entries()];
  }, [snapshot, filter, query]);

  const policyCount = useMemo(() => {
    const counts = { auto: 0, ask: 0, deny: 0 };
    for (const tool of snapshot?.tools ?? []) counts[tool.policy] += 1;
    return counts;
  }, [snapshot]);

  return (
    <main className="page-stage">
      <PageHeader
        eyebrow="Tool registry / immutable snapshot"
        title="工具"
        description="每个 Run 固定使用一个不可变工具快照。MCP 策略变更只影响新 Run，执行中的 Run 不会被热替换。"
        aside={
          <div className="header-actions">
            <button
              type="button"
              className="outline-button"
              onClick={() => void reload()}
              disabled={reloading}
            >
              {reloading ? "发现中" : "重新发现"}
            </button>
            <button
              type="button"
              className="dispatch-button"
              onClick={() => {
                setServerForm(emptyServerForm());
                setServerOpen((open) => !open);
              }}
            >
              {serverOpen ? "收起配置" : "添加 MCP"}
              <span aria-hidden="true">{serverOpen ? "−" : "+"}</span>
            </button>
          </div>
        }
      />

      {serverOpen && (
        <section className="memory-composer">
          <div className="memory-composer-head">
            <div>
              <p className="eyebrow">Remote MCP configuration</p>
              <h2>添加或更新 Server</h2>
            </div>
            <span className="composer-limit">secrets stay in env refs</span>
          </div>
          <div className="form-grid">
            <label>
              ID
              <input
                value={serverForm.id}
                onChange={(event) => patchServer(setServerForm, { id: event.target.value })}
                placeholder="github"
              />
            </label>
            <label>
              名称
              <input
                value={serverForm.name}
                onChange={(event) => patchServer(setServerForm, { name: event.target.value })}
                placeholder="GitHub MCP"
              />
            </label>
            <label>
              Transport
              <select
                value={serverForm.transport}
                onChange={(event) =>
                  patchServer(setServerForm, {
                    transport: event.target.value as "stdio" | "http",
                  })
                }
              >
                <option value="stdio">local stdio</option>
                <option value="http">Streamable HTTP</option>
              </select>
            </label>
            <label>
              启用
              <select
                value={serverForm.enabled ? "1" : "0"}
                onChange={(event) =>
                  patchServer(setServerForm, { enabled: event.target.value === "1" })
                }
              >
                <option value="1">enabled</option>
                <option value="0">disabled</option>
              </select>
            </label>
            {serverForm.transport === "stdio" ? (
              <>
                <label>
                  Command
                  <input
                    value={serverForm.command}
                    onChange={(event) =>
                      patchServer(setServerForm, { command: event.target.value })
                    }
                    placeholder="npx"
                  />
                </label>
                <label>
                  Arguments
                  <input
                    value={serverForm.args}
                    onChange={(event) => patchServer(setServerForm, { args: event.target.value })}
                    placeholder="-y, @modelcontextprotocol/server-github"
                  />
                </label>
              </>
            ) : (
              <label className="form-span-2">
                URL
                <input
                  value={serverForm.url}
                  onChange={(event) => patchServer(setServerForm, { url: event.target.value })}
                  placeholder="https://example.com/mcp"
                />
              </label>
            )}
            <label>
              Env refs
              <textarea
                rows={3}
                value={serverForm.envRefs}
                onChange={(event) => patchServer(setServerForm, { envRefs: event.target.value })}
                placeholder={"GITHUB_TOKEN=GITHUB_TOKEN"}
              />
            </label>
            <label>
              Header refs
              <textarea
                rows={3}
                value={serverForm.headers}
                onChange={(event) => patchServer(setServerForm, { headers: event.target.value })}
                placeholder={"Authorization=GITHUB_AUTH_HEADER"}
              />
            </label>
          </div>
          <div className="form-actions">
            <span>只保存变量引用，不保存 Token 值。保存后会自动重新发现工具。</span>
            <button type="button" className="dispatch-button" onClick={() => void saveServer()}>
              保存并重载
            </button>
          </div>
        </section>
      )}

      <div className="tool-snapshot-strip">
        <div className="snapshot-revision">
          <span>REVISION</span>
          <strong>{snapshot?.revision.toString().padStart(3, "0") ?? "---"}</strong>
        </div>
        <div className="snapshot-hash">
          <span>HASH</span>
          <code>{snapshot?.hash ?? "not loaded"}</code>
        </div>
        <div className="policy-totals">
          <span>
            <i className="policy-light auto" /> {policyCount.auto} auto
          </span>
          <span>
            <i className="policy-light ask" /> {policyCount.ask} ask
          </span>
          <span>
            <i className="policy-light deny" /> {policyCount.deny} deny
          </span>
        </div>
      </div>

      <section className="namespace-list">
        <div className="section-heading">
          <div>
            <p className="eyebrow">MCP control plane</p>
            <h2>Server 状态</h2>
          </div>
          <span className="namespace-count">{servers.length}</span>
        </div>
        {servers.length === 0 ? (
          <EmptyState
            glyph="⇢"
            title="还没有 MCP Server"
            copy="添加本地 stdio 或 Streamable HTTP server；凭据只通过环境变量引用注入。"
          />
        ) : (
          <div className="namespace-list">
            {servers.map((server) => (
              <article className="namespace-card" key={server.id}>
                <div className="namespace-head">
                  <div>
                    <div className="schedule-title">
                      <h2>{server.name}</h2>
                      <StatusDot active={server.status === "connected"} label={server.status} />
                    </div>
                    <p className="eyebrow">
                      {server.transport} / {server.id}
                    </p>
                  </div>
                  <div className="server-actions">
                    <button
                      type="button"
                      className="quiet-button"
                      onClick={() => {
                        setServerForm(fromServer(server));
                        setServerOpen(true);
                      }}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="quiet-button danger-text"
                      onClick={() => void removeServer(server)}
                    >
                      删除
                    </button>
                  </div>
                </div>
                <div className="tool-rows">
                  {server.tools.length === 0 ? (
                    <p className="muted-copy">
                      {server.enabled
                        ? "尚未发现工具，检查连接或执行重新发现。"
                        : "Server 已禁用。"}
                    </p>
                  ) : (
                    server.tools.map((tool) => (
                      <div className="tool-row" key={tool.name}>
                        <div>
                          <strong>{tool.name}</strong>
                          <p>{tool.description || "无描述"}</p>
                        </div>
                        <select
                          className="policy-select"
                          value={tool.policy}
                          onChange={(event) =>
                            void setPolicy(
                              server,
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
                    ))
                  )}
                </div>
                {server.lastError && (
                  <div className="inline-error">
                    <strong>Last error</strong>
                    <span>{server.lastError}</span>
                  </div>
                )}
                <small className="schedule-link">更新于 {timeAgo(server.updatedAt)}</small>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="filter-bar tool-filter-bar">
        <label className="search-field">
          <span>Search</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="命名空间、工具名或描述"
          />
        </label>
        <fieldset className="segmented-control" aria-label="按策略过滤">
          {(["all", "auto", "ask", "deny"] as const).map((item) => (
            <button
              type="button"
              key={item}
              className={filter === item ? "is-active" : ""}
              onClick={() => setFilter(item)}
            >
              {item}
            </button>
          ))}
        </fieldset>
      </section>

      <section className="namespace-list">
        {namespaces.length === 0 ? (
          <EmptyState
            glyph="⌘"
            title={loading ? "正在采集工具快照" : "没有匹配的工具"}
            copy="检查 Memory 工具是否已注册，或 MCP server 是否连接成功。"
          />
        ) : (
          namespaces.map(([namespace, items], index) => (
            <article
              className="namespace-card"
              key={namespace}
              style={{ animationDelay: `${index * 60}ms` }}
            >
              <div className="namespace-head">
                <div>
                  <p className="eyebrow">Namespace</p>
                  <h2>{namespace}</h2>
                </div>
                <span className="namespace-count">{items.length}</span>
              </div>
              <div className="tool-rows">
                {items.map((tool) => (
                  <div className="tool-row" key={`${tool.namespace}/${tool.name}`}>
                    <div>
                      <strong>{tool.name}</strong>
                      <p>{tool.description || "无描述"}</p>
                    </div>
                    <Tag
                      tone={
                        tool.policy === "auto"
                          ? "success"
                          : tool.policy === "ask"
                            ? "warning"
                            : "danger"
                      }
                    >
                      {tool.policy}
                    </Tag>
                  </div>
                ))}
              </div>
            </article>
          ))
        )}
      </section>

      <PanelNote title="审批边界">
        `ask` 策略通过 ApprovalBroker 进入 Run 审批流。群聊只向 Owner
        私聊展示完整命令；其他成员只能看到安全摘要。stdio 与 Streamable HTTP
        均使用环境变量引用，不在 SQLite 或浏览器中保存明文凭据。
      </PanelNote>
    </main>
  );
}

interface McpServerForm {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command: string;
  args: string;
  url: string;
  envRefs: string;
  headers: string;
  enabled: boolean;
}

function emptyServerForm(): McpServerForm {
  return {
    id: "",
    name: "",
    transport: "stdio",
    command: "",
    args: "",
    url: "",
    envRefs: "",
    headers: "",
    enabled: true,
  };
}

function fromServer(server: McpServerSummary): McpServerForm {
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    command: server.command ?? "",
    args: server.args.join(", "),
    url: server.url ?? "",
    envRefs: Object.entries(server.envRefs)
      .map(([target, source]) => `${target}=${source}`)
      .join("\n"),
    headers: Object.entries(server.headers)
      .map(([name, source]) => `${name}=${source}`)
      .join("\n"),
    enabled: server.enabled,
  };
}

function serverInput(form: McpServerForm): CreateMcpServerInput {
  if (!form.id.trim() || !form.name.trim()) {
    throw new Error("MCP server 需要 ID 和名称。");
  }
  const input: CreateMcpServerInput = {
    id: form.id.trim(),
    name: form.name.trim(),
    transport: form.transport,
    enabled: form.enabled,
    envRefs: parseAssignments(form.envRefs),
    headers: parseAssignments(form.headers),
  };
  if (form.transport === "stdio") {
    if (!form.command.trim()) throw new Error("stdio MCP server 需要 command。");
    input.command = form.command.trim();
    input.args = form.args
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  } else {
    if (!form.url.trim()) throw new Error("HTTP MCP server 需要 URL。");
    input.url = form.url.trim();
  }
  return input;
}

function parseAssignments(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of value.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const source = line.slice(separator + 1).trim();
    if (key && source) result[key] = source;
  }
  return result;
}

function patchServer(
  setter: Dispatch<SetStateAction<McpServerForm>>,
  patch: Partial<McpServerForm>,
): void {
  setter((current) => ({ ...current, ...patch }));
}
