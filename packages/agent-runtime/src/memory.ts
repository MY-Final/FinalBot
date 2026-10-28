import type { ToolInvocationContext } from "@finalbot/core";
import type { FinalBotDatabase, MemoryRecord, ScratchpadRecord } from "@finalbot/db";

const MEMORY_MAX_BYTES = 16 * 1024;
const SEARCH_MAX_RESULTS = 20;
const SEARCH_MAX_BYTES = 32 * 1024;
const SCRATCHPAD_MAX_BYTES = 64 * 1024;
const DEFAULT_TTL_DAYS = 7;

export interface MemorySearchResult {
  scope: "scratchpad" | "bot" | "owner";
  id: string;
  kind: string;
  content: string;
  tags: string[];
  confidence: number;
  updatedAt: string;
}

export class MemoryService {
  constructor(private readonly db: FinalBotDatabase) {}

  search(
    query: string,
    context: ToolInvocationContext,
    options: { limit?: number; kind?: string; tags?: string[] } = {},
  ): MemorySearchResult[] {
    const limit = Math.max(1, Math.min(options.limit ?? SEARCH_MAX_RESULTS, SEARCH_MAX_RESULTS));
    const results: MemorySearchResult[] = [];
    let bytes = 0;

    const scratchpad = this.db.getScratchpad(context.conversationId, context.botId);
    if (scratchpad) {
      const text = JSON.stringify(scratchpad.content);
      if (matches(text, query, options.tags ?? [], [])) {
        results.push({
          scope: "scratchpad",
          id: `scratchpad:${scratchpad.conversationId}:${scratchpad.botId}`,
          kind: "scratchpad",
          content: text,
          tags: [],
          confidence: 1,
          updatedAt: scratchpad.updatedAt,
        });
        bytes += Buffer.byteLength(text);
      }
    }

    for (const scope of ["bot", "owner"] as const) {
      const memoryQuery = normalizeQuery(query);
      let memories = this.db.listMemories({
        scope,
        ...(scope === "bot" ? { botId: context.botId } : { botId: null }),
        ...(options.kind ? { kind: options.kind } : {}),
        ...(memoryQuery ? { query: memoryQuery } : {}),
        limit,
      });
      if (memoryQuery && memories.length === 0) {
        memories = this.db.listMemories({
          scope,
          ...(scope === "bot" ? { botId: context.botId } : { botId: null }),
          ...(options.kind ? { kind: options.kind } : {}),
          limit,
        });
      }
      memories = memories.filter((memory) =>
        matches(
          `${memory.content} ${memory.tags.join(" ")}`,
          query,
          options.tags ?? [],
          memory.tags,
        ),
      );
      for (const memory of memories) {
        if (results.length >= limit) break;
        const size = Buffer.byteLength(memory.content);
        if (bytes + size > SEARCH_MAX_BYTES) break;
        results.push(toSearchResult(scope, memory));
        bytes += size;
      }
      if (results.length >= limit || bytes >= SEARCH_MAX_BYTES) break;
    }
    return results;
  }

  get(id: string): MemoryRecord | null {
    return this.db.getMemory(id);
  }

  write(
    input: {
      scope: "owner" | "bot";
      kind: string;
      content: string;
      tags?: string[];
      confidence?: number;
    },
    context: ToolInvocationContext,
  ): MemoryRecord {
    assertNoSecret(input.content);
    assertSize(input.content, MEMORY_MAX_BYTES, "Memory");
    const scope = input.scope;
    const botId = scope === "bot" ? context.botId : null;
    return this.db.upsertMemory({
      scope,
      botId,
      kind: input.kind.trim() || "note",
      content: input.content.trim(),
      normalizedContent: normalizeContent(input.content),
      tags: normalizeTags(input.tags ?? []),
      confidence: clamp(input.confidence ?? 1, 0, 1),
      sourceRunId: context.runId,
    });
  }

  update(
    id: string,
    input: {
      scope?: "owner" | "bot";
      botId?: string | null;
      kind?: string;
      content?: string;
      tags?: string[];
      confidence?: number;
    },
  ): MemoryRecord {
    const existing = this.db.getMemory(id);
    if (!existing) throw new Error(`Memory not found: ${id}`);
    const scope = input.scope ?? existing.scope;
    const content = input.content?.trim() ?? existing.content;
    assertNoSecret(content);
    assertSize(content, MEMORY_MAX_BYTES, "Memory");
    const botId = scope === "owner" ? null : (input.botId ?? existing.botId ?? "coder");
    return this.db.updateMemory({
      id,
      scope,
      botId,
      kind: input.kind?.trim() || existing.kind,
      content,
      normalizedContent: normalizeContent(content),
      tags: normalizeTags(input.tags ?? existing.tags),
      confidence: clamp(input.confidence ?? existing.confidence, 0, 1),
    });
  }

  delete(id: string, permanent = false): void {
    if (permanent) {
      this.db.deleteMemoryPermanently(id);
      return;
    }
    this.db.setMemoryStatus(id, "deleted");
  }

  list(input: Parameters<FinalBotDatabase["listMemories"]>[0] = {}): MemoryRecord[] {
    return this.db.listMemories(input);
  }
}

export class ScratchpadService {
  constructor(private readonly db: FinalBotDatabase) {}

  get(conversationId: string, botId: string): ScratchpadRecord | null {
    return this.db.getScratchpad(conversationId, botId);
  }

  set(input: {
    conversationId: string;
    botId: string;
    content: unknown;
    expectedRevision?: number;
    ttlDays?: number;
  }): ScratchpadRecord {
    const serialized = JSON.stringify(input.content);
    assertSize(serialized, SCRATCHPAD_MAX_BYTES, "Scratchpad");
    const ttlDays = input.ttlDays ?? DEFAULT_TTL_DAYS;
    return this.db.setScratchpad({
      conversationId: input.conversationId,
      botId: input.botId,
      content: input.content,
      ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
      expiresAt: new Date(Date.now() + Math.max(1, ttlDays) * 86_400_000).toISOString(),
    });
  }

  list(conversationId?: string): ScratchpadRecord[] {
    return this.db.listScratchpads(conversationId);
  }

  delete(conversationId: string, botId: string): boolean {
    return this.db.deleteScratchpad(conversationId, botId);
  }

  purgeExpired(): number {
    return this.db.purgeExpiredScratchpads();
  }
}

function toSearchResult(scope: "bot" | "owner", memory: MemoryRecord): MemorySearchResult {
  return {
    scope,
    id: memory.id,
    kind: memory.kind,
    content: memory.content,
    tags: memory.tags,
    confidence: memory.confidence,
    updatedAt: memory.updatedAt,
  };
}

function normalizeContent(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeQuery(value: string): string | undefined {
  const normalized = value.trim();
  return normalized || undefined;
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 32);
}

function matches(
  text: string,
  query: string,
  requiredTags: string[],
  availableTags: string[],
): boolean {
  const haystack = text.toLocaleLowerCase();
  const terms = query
    .toLocaleLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
  if (terms.length > 0 && !terms.every((term) => haystack.includes(term))) return false;
  const tags = new Set(availableTags.map((tag) => tag.toLocaleLowerCase()));
  return requiredTags.every((tag) => tags.has(tag.toLocaleLowerCase()));
}

function assertSize(value: string, max: number, label: string): void {
  if (Buffer.byteLength(value) > max) {
    throw new Error(`${label} exceeds ${max} bytes`);
  }
}

const SECRET_PATTERNS = [
  /\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:api[_ -]?key|password|passwd|secret|access[_ -]?token)\s*[:=]\s*\S{8,}/i,
];

function assertNoSecret(content: string): void {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(content))) {
    throw new Error("Refusing to store content that looks like a credential or private key");
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
