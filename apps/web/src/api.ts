import type {
  ApprovalSummary,
  HealthResponse,
  RunDetail,
  RunSummary,
  ServerEvent,
} from "@finalbot/protocol";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
      error?: string;
    } | null;
    throw new Error(body?.message ?? body?.error ?? `Request failed: ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  health: () => request<HealthResponse>("/api/health"),
  runs: () => request<RunSummary[]>("/api/runs"),
  run: (id: string) => request<RunDetail>(`/api/runs/${id}`),
  createRun: (prompt: string) =>
    request<RunSummary>("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    }),
  interrupt: (id: string) =>
    request<void>(`/api/runs/${id}/interrupt`, { method: "POST" }),
  resolveApproval: (id: string, action: ApprovalSummary["status"] | string) =>
    request<ApprovalSummary>(`/api/approvals/${id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    }),
};

export function subscribeEvents(
  onEvent: (event: ServerEvent) => void,
  onState: (connected: boolean) => void,
): () => void {
  const source = new EventSource("/api/events");
  source.onopen = () => onState(true);
  source.onerror = () => onState(false);
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as ServerEvent);
    } catch {
      // Ignore malformed events; the next event or snapshot will reconcile.
    }
  };
  return () => source.close();
}

