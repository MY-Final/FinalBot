import type {
  ApprovalSummary,
  BotSummary,
  ConversationPolicySummary,
  ConversationSummary,
  DiscussDecisionSummary,
  HealthResponse,
  McpServerSummary,
  MemorySummary,
  RunDetail,
  RunSummary,
  ScheduleSummary,
  ScratchpadSummary,
  ServerEvent,
  ToolCallSummary,
  ToolSummary,
} from "@finalbot/protocol";

const ADMIN_TOKEN_KEY = "finalbot.adminToken";

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export interface MemoryQuery {
  query?: string;
  scope?: "owner" | "bot";
  botId?: string;
  kind?: string;
  tag?: string;
  includeDeleted?: boolean;
}

export interface CreateMemoryInput {
  scope: "owner" | "bot";
  botId?: string | null;
  kind: string;
  content: string;
  tags: string[];
  confidence: number;
}

export type UpdateMemoryInput = Partial<CreateMemoryInput>;

export interface ToolSnapshotResponse {
  revision: number;
  hash: string;
  tools: ToolSummary[];
}

export interface CreateScheduleInput {
  name: string;
  expression: string;
  timezone: string;
  conversationId: string;
  botId: string;
  prompt: string;
  nextRunAt: string;
}

export interface PairingCodeResponse {
  code: string;
  expiresAt: string;
}

export interface CreateMcpServerInput {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command?: string | null;
  args?: string[];
  url?: string | null;
  envRefs?: Record<string, string>;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export function getAdminToken(): string {
  try {
    return sessionStorage.getItem(ADMIN_TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setAdminToken(token: string): void {
  try {
    if (token.trim()) {
      sessionStorage.setItem(ADMIN_TOKEN_KEY, token.trim());
    } else {
      sessionStorage.removeItem(ADMIN_TOKEN_KEY);
    }
  } catch {
    // sessionStorage can be unavailable in hardened browser contexts.
  }
}

function authHeaders(): Record<string, string> {
  const token = getAdminToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function notifyUnauthorized(): void {
  window.dispatchEvent(new CustomEvent("finalbot:unauthorized"));
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  for (const [key, value] of Object.entries(authHeaders())) headers.set(key, value);
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
      error?: string;
    } | null;
    if (response.status === 401) notifyUnauthorized();
    throw new ApiRequestError(
      body?.message ?? body?.error ?? `Request failed: ${response.status}`,
      response.status,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function memorySearch(query: MemoryQuery): string {
  const params = new URLSearchParams();
  if (query.query?.trim()) params.set("query", query.query.trim());
  if (query.scope) params.set("scope", query.scope);
  if (query.botId?.trim()) params.set("botId", query.botId.trim());
  if (query.kind?.trim()) params.set("kind", query.kind.trim());
  if (query.tag?.trim()) params.set("tag", query.tag.trim());
  if (query.includeDeleted) params.set("includeDeleted", "1");
  const value = params.toString();
  return value ? `?${value}` : "";
}

export const api = {
  health: () => request<HealthResponse>("/api/health"),
  bots: () => request<BotSummary[]>("/api/bots"),
  channels: () => request<HealthResponse["channels"]>("/api/channels"),
  runs: () => request<RunSummary[]>("/api/runs"),
  run: (id: string) => request<RunDetail>(`/api/runs/${id}`),
  createRun: (prompt: string, botId?: string) =>
    request<RunSummary>("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, ...(botId ? { botId } : {}) }),
    }),
  interrupt: (id: string) => request<void>(`/api/runs/${id}/interrupt`, { method: "POST" }),
  resolveApproval: (id: string, action: ApprovalSummary["status"] | string) =>
    request<ApprovalSummary>(`/api/approvals/${id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    }),
  memory: (query: MemoryQuery = {}) =>
    request<MemorySummary[]>(`/api/memory${memorySearch(query)}`),
  createMemory: (input: CreateMemoryInput) =>
    request<MemorySummary>("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  updateMemory: (id: string, input: UpdateMemoryInput) =>
    request<MemorySummary>(`/api/memory/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  deleteMemory: (id: string, permanent = false) =>
    request<void>(`/api/memory/${encodeURIComponent(id)}${permanent ? "?permanent=1" : ""}`, {
      method: "DELETE",
    }),
  tools: () => request<ToolSnapshotResponse>("/api/tools"),
  toolCalls: (runId: string) =>
    request<ToolCallSummary[]>(`/api/tool-calls?runId=${encodeURIComponent(runId)}`),
  conversations: () => request<ConversationSummary[]>("/api/conversations"),
  updateConversationPolicy: (
    id: string,
    input: Pick<ConversationPolicySummary, "observeAll" | "discussEnabled">,
  ) =>
    request<ConversationPolicySummary>(`/api/conversations/${encodeURIComponent(id)}/policy`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  scratchpads: (conversationId?: string) =>
    request<ScratchpadSummary[]>(
      `/api/scratchpads${conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ""}`,
    ),
  scratchpad: (conversationId: string, botId: string) =>
    request<ScratchpadSummary>(
      `/api/scratchpads/${encodeURIComponent(conversationId)}/${encodeURIComponent(botId)}`,
    ),
  saveScratchpad: (
    conversationId: string,
    botId: string,
    input: { content: unknown; expectedRevision?: number; ttlDays?: number },
  ) =>
    request<ScratchpadSummary>(
      `/api/scratchpads/${encodeURIComponent(conversationId)}/${encodeURIComponent(botId)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    ),
  deleteScratchpad: (conversationId: string, botId: string) =>
    request<void>(
      `/api/scratchpads/${encodeURIComponent(conversationId)}/${encodeURIComponent(botId)}`,
      { method: "DELETE" },
    ),
  mcpServers: () => request<McpServerSummary[]>("/api/mcp/servers"),
  saveMcpServer: (input: CreateMcpServerInput) =>
    request<McpServerSummary>("/api/mcp/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  reloadMcp: () =>
    request<{ revision: number; hash: string; servers: McpServerSummary[] }>("/api/mcp/reload", {
      method: "POST",
    }),
  updateMcpPolicy: (serverId: string, toolName: string, policy: "auto" | "ask" | "deny") =>
    request<ToolSnapshotResponse>(`/api/mcp/servers/${encodeURIComponent(serverId)}/policy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolName, policy }),
    }),
  deleteMcpServer: (serverId: string) =>
    request<void>(`/api/mcp/servers/${encodeURIComponent(serverId)}`, {
      method: "DELETE",
    }),
  discussDecisions: (conversationId?: string) =>
    request<DiscussDecisionSummary[]>(
      `/api/discuss/decisions${
        conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ""
      }`,
    ),
  schedules: () => request<ScheduleSummary[]>("/api/schedules"),
  createSchedule: (input: CreateScheduleInput) =>
    request<ScheduleSummary>("/api/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  toggleSchedule: (id: string) =>
    request<ScheduleSummary>(`/api/schedules/${encodeURIComponent(id)}/toggle`, {
      method: "POST",
    }),
  pairingCode: () =>
    request<PairingCodeResponse>("/api/owner/pairing-code", {
      method: "POST",
    }),
};

interface SseFrame {
  id: string | null;
  data: string;
}

function parseSseFrames(buffer: string): {
  frames: SseFrame[];
  remainder: string;
} {
  const normalized = buffer.replaceAll("\r\n", "\n");
  const parts = normalized.split("\n\n");
  const remainder = parts.pop() ?? "";
  const frames: SseFrame[] = [];
  for (const part of parts) {
    let id: string | null = null;
    const data: string[] = [];
    for (const line of part.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = separator >= 0 ? line.slice(0, separator) : line;
      let value = separator >= 0 ? line.slice(separator + 1) : "";
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "id") id = value;
      if (field === "data") data.push(value);
    }
    if (data.length > 0) frames.push({ id, data: data.join("\n") });
  }
  return { frames, remainder };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

/**
 * EventSource cannot carry an Authorization header, so the event stream uses
 * fetch + ReadableStream. The server supports both Last-Event-ID and ?after.
 */
export function subscribeEvents(
  onEvent: (event: ServerEvent) => void,
  onState: (connected: boolean) => void,
  onUnauthorized?: () => void,
): () => void {
  let stopped = false;
  let controller: AbortController | null = null;
  let lastEventId: string | null = null;

  async function run(): Promise<void> {
    let retryDelay = 1_000;
    while (!stopped) {
      controller = new AbortController();
      const signal = controller.signal;
      const params = new URLSearchParams();
      if (lastEventId) params.set("after", lastEventId);
      const suffix = params.size > 0 ? `?${params.toString()}` : "";
      try {
        const headers = new Headers(authHeaders());
        headers.set("Accept", "text/event-stream");
        if (lastEventId) headers.set("Last-Event-ID", lastEventId);
        const response = await fetch(`/api/events${suffix}`, {
          headers,
          cache: "no-store",
          signal,
        });
        if (response.status === 401) {
          onState(false);
          onUnauthorized?.();
          notifyUnauthorized();
          return;
        }
        if (!response.ok || !response.body) {
          throw new Error(`Event stream failed: ${response.status}`);
        }
        onState(true);
        retryDelay = 1_000;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!stopped) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parsed = parseSseFrames(buffer);
          buffer = parsed.remainder;
          for (const frame of parsed.frames) {
            if (frame.id) lastEventId = frame.id;
            try {
              onEvent(JSON.parse(frame.data) as ServerEvent);
            } catch {
              // Ignore malformed events; the next snapshot or event reconciles state.
            }
          }
        }
        if (!stopped) throw new Error("Event stream disconnected");
      } catch (error) {
        if (stopped || (error instanceof DOMException && error.name === "AbortError")) return;
        onState(false);
      }
      try {
        await sleep(retryDelay, signal);
      } catch {
        return;
      }
      retryDelay = Math.min(retryDelay * 2, 15_000);
    }
  }

  void run();
  return () => {
    stopped = true;
    controller?.abort();
    onState(false);
  };
}
