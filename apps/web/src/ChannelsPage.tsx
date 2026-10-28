import type {
  ChannelSummary,
  ConversationSummary,
  DiscussDecisionSummary,
} from "@finalbot/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type PairingCodeResponse } from "./api";
import { EmptyState, formatDateTime, PageHeader, PanelNote, StatusDot, Tag } from "./ui";

export interface ChannelsPageProps {
  channels: ChannelSummary[];
  loading: boolean;
  onRefresh: () => Promise<void>;
  onError: (message: string | null) => void;
}

export function ChannelsPage({ channels, loading, onRefresh, onError }: ChannelsPageProps) {
  const [pairing, setPairing] = useState<PairingCodeResponse | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState("");
  const [decisions, setDecisions] = useState<DiscussDecisionSummary[]>([]);
  const connected = channels.filter((channel) => channel.connected).length;

  const loadPolicies = useCallback(async (): Promise<void> => {
    try {
      const [nextConversations, nextDecisions] = await Promise.all([
        api.conversations(),
        api.discussDecisions(),
      ]);
      setConversations(nextConversations);
      setDecisions(nextDecisions);
      setSelectedConversationId(
        (current) =>
          current || nextConversations.find((item) => item.conversationKind === "group")?.id || "",
      );
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }, [onError]);

  useEffect(() => {
    const timer = setInterval(() => void onRefresh(), 20_000);
    return () => clearInterval(timer);
  }, [onRefresh]);

  useEffect(() => {
    void loadPolicies();
  }, [loadPolicies]);

  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedConversationId) ?? null,
    [conversations, selectedConversationId],
  );

  async function createPairingCode(): Promise<void> {
    setPairingBusy(true);
    onError(null);
    try {
      setPairing(await api.pairingCode());
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setPairingBusy(false);
    }
  }

  async function copyCode(): Promise<void> {
    if (!pairing) return;
    try {
      await navigator.clipboard.writeText(`/pair ${pairing.code}`);
    } catch {
      onError("浏览器无法访问剪贴板，请手动复制配对码。");
    }
  }

  async function updatePolicy(patch: {
    observeAll?: boolean;
    discussEnabled?: boolean;
  }): Promise<void> {
    if (!selectedConversation) return;
    onError(null);
    try {
      const policy = await api.updateConversationPolicy(selectedConversation.id, {
        observeAll: patch.observeAll ?? selectedConversation.policy.observeAll,
        discussEnabled: patch.discussEnabled ?? selectedConversation.policy.discussEnabled,
      });
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === selectedConversation.id ? { ...conversation, policy } : conversation,
        ),
      );
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <main className="page-stage">
      <PageHeader
        eyebrow="Channel gateway / inbound + outbound"
        title="通道"
        description="所有 IM 与 Web 都通过统一 OutboundAddress 进出。QQ 官方仅支持被动回复，Web 是本地控制面。"
        aside={
          <button
            type="button"
            className="outline-button"
            onClick={() => void onRefresh()}
            disabled={loading}
          >
            {loading ? "刷新中" : "刷新状态"}
          </button>
        }
      />

      <div className="metric-strip">
        <div>
          <span className="metric-value">{connected}</span>
          <span className="metric-label">Connected</span>
        </div>
        <div>
          <span className="metric-value">{channels.length}</span>
          <span className="metric-label">Registered</span>
        </div>
        <div>
          <span className="metric-value">
            {channels.filter((channel) => channel.capabilities.proactiveSend).length}
          </span>
          <span className="metric-label">Proactive</span>
        </div>
        <div className="metric-note">
          <StatusDot active={connected > 0} label={connected > 0 ? "Gateway online" : "No link"} />
        </div>
      </div>

      <div className="channels-layout">
        <section className="channel-grid">
          {channels.length === 0 ? (
            <EmptyState
              title="没有已注册通道"
              copy="检查 OneBot WebSocket 或 QQ 官方环境变量配置后重启服务。"
            />
          ) : (
            channels.map((channel, index) => (
              <article
                className={`channel-card ${channel.connected ? "is-connected" : ""}`}
                key={channel.id}
                style={{ animationDelay: `${index * 55}ms` }}
              >
                <div className="channel-card-head">
                  <div className="channel-sigil">{channel.type.slice(0, 2).toUpperCase()}</div>
                  <div>
                    <h2>{channel.type}</h2>
                    <p>{channel.id}</p>
                  </div>
                  <StatusDot
                    active={channel.connected}
                    label={channel.connected ? "在线" : "离线"}
                  />
                </div>

                <dl className="channel-meta">
                  <div>
                    <dt>Account</dt>
                    <dd title={channel.accountId ?? ""}>{channel.accountId ?? "未发现"}</dd>
                  </div>
                  <div>
                    <dt>Configured</dt>
                    <dd>{channel.configured ? "YES" : "NO"}</dd>
                  </div>
                  <div>
                    <dt>Enabled</dt>
                    <dd>{channel.enabled ? "YES" : "NO"}</dd>
                  </div>
                  <div>
                    <dt>Max text</dt>
                    <dd>{channel.capabilities.maxTextLength.toLocaleString()} chars</dd>
                  </div>
                </dl>

                <div className="capability-row">
                  <Tag tone={channel.capabilities.observeAll ? "sea" : "neutral"}>
                    {channel.capabilities.observeAll ? "observe all" : "mention only"}
                  </Tag>
                  <Tag tone={channel.capabilities.proactiveSend ? "success" : "warning"}>
                    {channel.capabilities.proactiveSend ? "proactive" : "passive"}
                  </Tag>
                  <Tag tone={channel.capabilities.reply ? "sea" : "neutral"}>
                    {channel.capabilities.reply ? "reply" : "send only"}
                  </Tag>
                  <Tag tone={channel.capabilities.markdown ? "signal" : "neutral"}>
                    {channel.capabilities.markdown ? "markdown" : "text"}
                  </Tag>
                </div>

                {channel.lastError && (
                  <div className="inline-error">
                    <strong>Last error</strong>
                    <span>{channel.lastError}</span>
                  </div>
                )}
              </article>
            ))
          )}
        </section>

        <aside className="side-stack">
          <section className="owner-card">
            <p className="eyebrow">Owner binding</p>
            <h2>认领你的 IM 身份</h2>
            <p>
              在 Web 生成一次性配对码，然后用 Owner 的私聊发送
              <code>/pair &lt;code&gt;</code>。群内其他成员只能成为观察上下文。
            </p>
            {pairing ? (
              <div className="pairing-ticket">
                <span>PAIR CODE</span>
                <strong>{pairing.code}</strong>
                <small>有效至 {formatDateTime(pairing.expiresAt)}</small>
                <button type="button" className="outline-button" onClick={() => void copyCode()}>
                  复制 /pair 命令
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="dispatch-button pairing-button"
                onClick={() => void createPairingCode()}
                disabled={pairingBusy}
              >
                {pairingBusy ? "生成中" : "生成 10 分钟配对码"}
                <span aria-hidden="true">↗</span>
              </button>
            )}
          </section>

          <section className="owner-card">
            <p className="eyebrow">Conversation policy</p>
            <h2>群聊参与策略</h2>
            <label>
              对话
              <select
                value={selectedConversationId}
                onChange={(event) => setSelectedConversationId(event.target.value)}
              >
                <option value="">选择群聊</option>
                {conversations
                  .filter((conversation) => conversation.conversationKind === "group")
                  .map((conversation) => (
                    <option value={conversation.id} key={conversation.id}>
                      {conversation.title || conversation.externalId} / {conversation.channel}
                    </option>
                  ))}
              </select>
            </label>
            {selectedConversation ? (
              <div className="policy-toggles">
                <label>
                  <input
                    type="checkbox"
                    checked={selectedConversation.policy.observeAll}
                    onChange={(event) => void updatePolicy({ observeAll: event.target.checked })}
                  />
                  观察未 @ 消息
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={selectedConversation.policy.discussEnabled}
                    onChange={(event) =>
                      void updatePolicy({ discussEnabled: event.target.checked })
                    }
                  />
                  使用 Discuss Gate
                </label>
              </div>
            ) : (
              <p className="muted-copy">
                没有已持久化群聊。OneBot 收到群消息后会出现在这里；QQ 官方只收到 @ 消息。
              </p>
            )}
            <div className="discuss-mini-list">
              <span>最近 Discuss 决策</span>
              {decisions.length === 0 ? (
                <p className="muted-copy">暂无决策记录。</p>
              ) : (
                decisions.slice(0, 5).map((decision) => (
                  <div key={decision.id}>
                    <Tag tone={decision.action === "send" ? "success" : "neutral"}>
                      {decision.action}
                    </Tag>
                    <small>{decision.reason}</small>
                  </div>
                ))
              )}
            </div>
          </section>

          <PanelNote title="QQ 官方边界">
            QQ 官方首版只接入 C2C 与群聊 @ 事件，不接收未 @
            的群消息，也不能主动推送。超过单次回复窗口的内容会截断，并提示到 Web 查看完整结果。
          </PanelNote>
        </aside>
      </div>
    </main>
  );
}
