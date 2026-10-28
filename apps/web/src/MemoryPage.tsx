import type {
  BotSummary,
  ConversationSummary,
  MemorySummary,
  ScratchpadSummary,
} from "@finalbot/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type CreateMemoryInput, type MemoryQuery } from "./api";
import { EmptyState, PageHeader, PanelNote, Tag, timeAgo } from "./ui";

export interface MemoryPageProps {
  bots: BotSummary[];
  onError: (message: string | null) => void;
}

const EMPTY_FORM: CreateMemoryInput = {
  scope: "owner",
  botId: null,
  kind: "note",
  content: "",
  tags: [],
  confidence: 1,
};

export function MemoryPage({ bots, onError }: MemoryPageProps) {
  const [memories, setMemories] = useState<MemorySummary[]>([]);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"" | "owner" | "bot">("");
  const [botId, setBotId] = useState("");
  const [kind, setKind] = useState("");
  const [tag, setTag] = useState("");
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState<CreateMemoryInput>(EMPTY_FORM);
  const [formTags, setFormTags] = useState("");
  const [saving, setSaving] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const filters = useMemo<MemoryQuery>(
    () => ({
      ...(query.trim() ? { query } : {}),
      ...(scope ? { scope } : {}),
      ...(botId && scope !== "owner" ? { botId } : {}),
      ...(kind.trim() ? { kind } : {}),
      ...(tag.trim() ? { tag } : {}),
      includeDeleted,
    }),
    [query, scope, botId, kind, tag, includeDeleted],
  );

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    onError(null);
    try {
      setMemories(await api.memory(filters));
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [filters, onError]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 180);
    return () => clearTimeout(timer);
  }, [load]);

  async function save(): Promise<void> {
    if (!form.content.trim() || saving) return;
    setSaving(true);
    onError(null);
    try {
      const payload = {
        ...form,
        botId: form.scope === "bot" ? (form.botId ?? bots[0]?.id ?? "coder") : null,
        content: form.content.trim(),
        tags: parseTags(formTags),
      };
      if (editingId) await api.updateMemory(editingId, payload);
      else await api.createMemory(payload);
      setEditingId(null);
      setForm(EMPTY_FORM);
      setFormTags("");
      setComposerOpen(false);
      await load();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  function edit(memory: MemorySummary): void {
    setEditingId(memory.id);
    setForm({
      scope: memory.scope,
      botId: memory.botId,
      kind: memory.kind,
      content: memory.content,
      tags: memory.tags,
      confidence: memory.confidence,
    });
    setFormTags(memory.tags.join(", "));
    setComposerOpen(true);
  }

  function closeComposer(): void {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormTags("");
    setComposerOpen(false);
  }

  async function remove(memory: MemorySummary, permanent: boolean): Promise<void> {
    const prompt = permanent
      ? "永久清除后无法恢复，确认继续？"
      : "这条记忆会软删除，可在“显示已删除”中找回。";
    if (!window.confirm(`${memory.content.slice(0, 48)}\n\n${prompt}`)) return;
    onError(null);
    try {
      await api.deleteMemory(memory.id, permanent);
      setMemories((current) =>
        permanent
          ? current.filter((item) => item.id !== memory.id)
          : current.map((item) => (item.id === memory.id ? { ...item, status: "deleted" } : item)),
      );
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  const activeCount = memories.filter((memory) => memory.status === "active").length;

  return (
    <main className="page-stage">
      <PageHeader
        eyebrow="Three-layer memory / explicit writes"
        title="记忆"
        description="Owner 记忆跨渠道共享，Bot 记忆按角色隔离。检索顺序是 Scratchpad → Bot → Owner，并标注来源层级。"
        aside={
          <button
            type="button"
            className="dispatch-button"
            onClick={() => {
              if (composerOpen) closeComposer();
              else setComposerOpen(true);
            }}
          >
            {composerOpen ? "收起写入" : "写入记忆"}
            <span aria-hidden="true">{composerOpen ? "−" : "+"}</span>
          </button>
        }
      />

      {composerOpen && (
        <section className="memory-composer">
          <div className="memory-composer-head">
            <div>
              <p className="eyebrow">Explicit memory write</p>
              <h2>{editingId ? "编辑记忆" : "新增或更新一条记忆"}</h2>
            </div>
            <span className="composer-limit">16 KiB / secret scan on</span>
          </div>
          <div className="form-grid">
            <label>
              层级
              <select
                value={form.scope}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    scope: event.target.value as "owner" | "bot",
                  }))
                }
              >
                <option value="owner">Owner / 跨渠道</option>
                <option value="bot">Bot / 角色隔离</option>
              </select>
            </label>
            <label>
              Bot
              <select
                value={form.botId ?? bots[0]?.id ?? ""}
                disabled={form.scope !== "bot"}
                onChange={(event) =>
                  setForm((current) => ({ ...current, botId: event.target.value }))
                }
              >
                {bots.map((bot) => (
                  <option key={bot.id} value={bot.id}>
                    {bot.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Kind
              <input
                value={form.kind}
                onChange={(event) =>
                  setForm((current) => ({ ...current, kind: event.target.value }))
                }
                placeholder="preference / fact / note"
              />
            </label>
            <label>
              Confidence
              <input
                type="number"
                min="0"
                max="1"
                step="0.05"
                value={form.confidence}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    confidence: Number(event.target.value),
                  }))
                }
              />
            </label>
          </div>
          <label className="form-wide">
            内容
            <textarea
              value={form.content}
              onChange={(event) =>
                setForm((current) => ({ ...current, content: event.target.value }))
              }
              rows={5}
              placeholder="只写长期有价值、且明确允许保存的内容。不要把密钥、Token 或密码写进记忆。"
            />
          </label>
          <label className="form-wide">
            标签
            <input
              value={formTags}
              onChange={(event) => setFormTags(event.target.value)}
              placeholder="用逗号分隔，例如：偏好, 工作流, 前端"
            />
          </label>
          <div className="form-actions">
            <span>完全重复的内容会更新标签、置信度与更新时间。</span>
            <button
              type="button"
              className="dispatch-button"
              onClick={() => void save()}
              disabled={saving || !form.content.trim()}
            >
              {saving ? "保存中" : editingId ? "保存修改" : "保存记忆"}
            </button>
          </div>
        </section>
      )}

      <section className="filter-bar">
        <label className="search-field">
          <span>Search</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="关键词 / 中文二元检索"
          />
        </label>
        <label>
          Scope
          <select
            value={scope}
            onChange={(event) => setScope(event.target.value as "" | "owner" | "bot")}
          >
            <option value="">全部</option>
            <option value="owner">Owner</option>
            <option value="bot">Bot</option>
          </select>
        </label>
        <label>
          Bot
          <select
            value={botId}
            disabled={scope === "owner"}
            onChange={(event) => setBotId(event.target.value)}
          >
            <option value="">全部</option>
            {bots.map((bot) => (
              <option key={bot.id} value={bot.id}>
                {bot.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Kind
          <input
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            placeholder="全部"
          />
        </label>
        <label>
          Tag
          <input value={tag} onChange={(event) => setTag(event.target.value)} placeholder="全部" />
        </label>
        <label className="check-field">
          <input
            type="checkbox"
            checked={includeDeleted}
            onChange={(event) => setIncludeDeleted(event.target.checked)}
          />
          显示已删除
        </label>
      </section>

      <div className="memory-summary">
        <span>
          <b>{memories.length}</b> 条结果
        </span>
        <span>
          <b>{activeCount}</b> 条有效
        </span>
        <span>{loading ? "检索中..." : "FTS5 / unicode61 + CJK bigrams"}</span>
      </div>

      <section className="memory-list">
        {memories.length === 0 && !loading ? (
          <EmptyState
            glyph="◌"
            title="没有匹配的记忆"
            copy="放宽过滤条件，或明确写入一条记忆。FinalBot 不会每轮自动提取。"
          />
        ) : (
          memories.map((memory, index) => (
            <article
              className={`memory-card ${memory.status === "deleted" ? "is-deleted" : ""}`}
              key={memory.id}
              style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}
            >
              <div className="memory-rail">
                <Tag tone={memory.scope === "owner" ? "signal" : "sea"}>{memory.scope}</Tag>
                <span className="memory-bot">{memory.botId ?? "global"}</span>
                <span className="memory-confidence">{Math.round(memory.confidence * 100)}%</span>
              </div>
              <div className="memory-body">
                <div className="memory-meta">
                  <span>{memory.kind}</span>
                  <span>{timeAgo(memory.updatedAt)}</span>
                  {memory.status === "deleted" && <Tag tone="danger">deleted</Tag>}
                </div>
                <p>{memory.content}</p>
                <div className="memory-tags">
                  {memory.tags.map((item) => (
                    <button type="button" key={item} onClick={() => setTag(item)}>
                      #{item}
                    </button>
                  ))}
                </div>
              </div>
              <div className="memory-actions">
                {memory.status === "active" && (
                  <button type="button" onClick={() => edit(memory)}>
                    编辑
                  </button>
                )}
                {memory.status === "active" ? (
                  <button type="button" onClick={() => void remove(memory, false)}>
                    软删除
                  </button>
                ) : (
                  <button
                    type="button"
                    className="danger-text"
                    onClick={() => void remove(memory, true)}
                  >
                    永久清除
                  </button>
                )}
              </div>
            </article>
          ))
        )}
      </section>

      <ScratchpadPanel bots={bots} onError={onError} />

      <PanelNote title="本阶段可做范围" tone="warning">
        记忆写入会扫描疑似凭据。软删除的条目可以恢复显示，永久清除不可撤销。Scratchpad
        通过工具与对话绑定，不在普通记忆列表中混用。
      </PanelNote>
    </main>
  );
}

function ScratchpadPanel({
  bots,
  onError,
}: {
  bots: BotSummary[];
  onError: (message: string | null) => void;
}) {
  const [items, setItems] = useState<ScratchpadSummary[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationId, setConversationId] = useState("");
  const [botId, setBotId] = useState("coder");
  const [body, setBody] = useState('{\n  "task": ""\n}');
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    onError(null);
    try {
      const [nextItems, nextConversations] = await Promise.all([
        api.scratchpads(),
        api.conversations(),
      ]);
      setItems(nextItems);
      setConversations(nextConversations);
      setConversationId((current) => current || nextConversations[0]?.id || "");
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const item = items.find(
      (candidate) => candidate.conversationId === conversationId && candidate.botId === botId,
    );
    if (item) {
      setRevision(item.revision);
      setBody(JSON.stringify(item.content, null, 2));
    } else {
      setRevision(0);
      setBody('{\n  "task": ""\n}');
    }
  }, [items, conversationId, botId]);

  async function save(): Promise<void> {
    if (!conversationId || saving) return;
    let content: unknown;
    try {
      content = JSON.parse(body);
    } catch {
      onError("Scratchpad 必须是合法 JSON。");
      return;
    }
    setSaving(true);
    onError(null);
    try {
      const saved = await api.saveScratchpad(conversationId, botId, {
        content,
        expectedRevision: revision,
        ttlDays: 7,
      });
      setItems((current) => [
        saved,
        ...current.filter(
          (item) => !(item.conversationId === saved.conversationId && item.botId === saved.botId),
        ),
      ]);
      setRevision(saved.revision);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function remove(): Promise<void> {
    if (!conversationId) return;
    try {
      await api.deleteScratchpad(conversationId, botId);
      setItems((current) =>
        current.filter((item) => !(item.conversationId === conversationId && item.botId === botId)),
      );
      setRevision(0);
      setBody('{\n  "task": ""\n}');
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <section className="memory-composer">
      <div className="memory-composer-head">
        <div>
          <p className="eyebrow">Scratchpad / conversation + bot</p>
          <h2>工作草稿</h2>
        </div>
        <span className="composer-limit">revision {revision}</span>
      </div>
      <div className="form-grid">
        <label>
          对话
          <select
            value={conversationId}
            onChange={(event) => setConversationId(event.target.value)}
          >
            {conversations.map((conversation) => (
              <option value={conversation.id} key={conversation.id}>
                {conversation.title || conversation.externalId} / {conversation.channel}
              </option>
            ))}
          </select>
        </label>
        <label>
          Bot
          <select value={botId} onChange={(event) => setBotId(event.target.value)}>
            {bots.map((bot) => (
              <option value={bot.id} key={bot.id}>
                {bot.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="form-wide">
        JSON
        <textarea
          className="code-input"
          rows={7}
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
      </label>
      <div className="form-actions">
        <span>{loading ? "读取中..." : "最多 64 KiB，默认 TTL 7 天"}</span>
        <div>
          <button type="button" className="quiet-button" onClick={() => void remove()}>
            删除
          </button>
          <button
            type="button"
            className="dispatch-button"
            onClick={() => void save()}
            disabled={saving || !conversationId}
          >
            {saving ? "保存中" : "保存草稿"}
          </button>
        </div>
      </div>
    </section>
  );
}

function parseTags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,，]/)
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}
