import type { ReactNode } from "react";

export function timeAgo(iso: string | null): string {
  if (!iso) return "未记录";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 10) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return new Date(iso).toLocaleDateString("zh-CN");
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "未安排";
  return new Date(iso).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function shorten(value: string, max = 72): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max)}...` : compact;
}

export function PageHeader({
  eyebrow,
  title,
  description,
  aside,
}: {
  eyebrow: string;
  title: string;
  description: string;
  aside?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="page-description">{description}</p>
      </div>
      {aside && <div className="page-header-aside">{aside}</div>}
    </header>
  );
}

export function EmptyState({
  glyph = "∅",
  title,
  copy,
}: {
  glyph?: string;
  title: string;
  copy: string;
}) {
  return (
    <div className="empty-state">
      <span className="empty-glyph">{glyph}</span>
      <p>{title}</p>
      <small>{copy}</small>
    </div>
  );
}

export function StatusDot({ active, label }: { active: boolean; label: string }) {
  return (
    <span className={`status-dot-label ${active ? "is-active" : ""}`}>
      <i />
      {label}
    </span>
  );
}

export function Tag({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "sea" | "signal" | "success" | "warning" | "danger";
}) {
  return <span className={`tag tag-${tone}`}>{children}</span>;
}

export function PanelNote({
  title,
  children,
  tone = "neutral",
}: {
  title: string;
  children: ReactNode;
  tone?: "neutral" | "warning";
}) {
  return (
    <div className={`panel-note ${tone === "warning" ? "is-warning" : ""}`}>
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  );
}
