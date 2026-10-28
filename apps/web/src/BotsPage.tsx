import type { BotSummary, RunSummary } from "@finalbot/protocol";
import { EmptyState, PageHeader, Tag, timeAgo } from "./ui";

export function BotsPage({ bots, runs }: { bots: BotSummary[]; runs: RunSummary[] }) {
  return (
    <main className="page-stage">
      <PageHeader
        eyebrow="Agent roster / workspace isolation"
        title="Bots"
        description="每个 Bot 有独立角色、模型与工作区策略。派发任务时由 Personal Assistant 选择对应执行者。"
      />

      <div className="agent-roster">
        {bots.length === 0 ? (
          <EmptyState title="没有启用中的 Bot" copy="检查 bot_profiles 配置。" />
        ) : (
          bots.map((bot, index) => {
            const botRuns = runs.filter((run) => run.botId === bot.id);
            const active = botRuns.filter(
              (run) => !["succeeded", "failed", "cancelled", "interrupted"].includes(run.state),
            ).length;
            return (
              <article
                className="bot-card"
                key={bot.id}
                style={{ animationDelay: `${index * 65}ms` }}
              >
                <div className="bot-card-index">{String(index + 1).padStart(2, "0")}</div>
                <div className="bot-card-main">
                  <div className="bot-title-row">
                    <div>
                      <p className="eyebrow">{bot.id}</p>
                      <h2>{bot.name}</h2>
                    </div>
                    <Tag tone={bot.enabled ? "success" : "neutral"}>
                      {bot.enabled ? "enabled" : "disabled"}
                    </Tag>
                  </div>
                  <p className="bot-description">{bot.description || "未设置角色说明。"}</p>
                  <div className="bot-spec-grid">
                    <div>
                      <span>AGENT</span>
                      <strong>{bot.agent}</strong>
                    </div>
                    <div>
                      <span>MODEL</span>
                      <strong>{bot.model ?? "default"}</strong>
                    </div>
                    <div>
                      <span>WORKSPACE</span>
                      <strong>{workspaceLabel(bot.workspaceMode)}</strong>
                    </div>
                    <div>
                      <span>ACTIVE</span>
                      <strong>{active}</strong>
                    </div>
                  </div>
                </div>
                <div className="bot-card-foot">
                  <span>{botRuns.length} runs assigned</span>
                  <span>{botRuns[0] ? `last ${timeAgo(botRuns[0].createdAt)}` : "尚未执行"}</span>
                </div>
              </article>
            );
          })
        )}
      </div>
    </main>
  );
}

function workspaceLabel(mode: BotSummary["workspaceMode"]): string {
  if (mode === "git-worktree") return "Git worktree";
  if (mode === "shared-directory") return "Shared directory";
  return "Isolated scratch";
}
