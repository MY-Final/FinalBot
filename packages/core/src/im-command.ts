export type ImCommand =
  | {
      kind: "approve" | "approve_session" | "deny";
      raw: string;
      requestId?: string;
    }
  | {
      kind: "cancel" | "status" | "help" | "unknown";
      raw: string;
    };

/**
 * Parses a user-facing command after removing mentions added by the channel.
 * A normal prompt returns null so it can continue through the Inbox.
 */
export function parseImCommand(input: string): ImCommand | null {
  const text = stripLeadingMentions(input);
  if (!text.startsWith("/")) return null;

  const match = /^\/([^\s]+)(?:\s+(.*))?$/.exec(text);
  if (!match) return { kind: "unknown", raw: text };

  const name = (match[1] ?? "").toLowerCase();
  const argument = (match[2] ?? "").trim();
  if (argument && /\s/.test(argument)) {
    return { kind: "unknown", raw: text };
  }

  switch (name) {
    case "approve":
    case "allow":
    case "ok":
      return withOptionalRequestId("approve", argument, text);
    case "approve_session":
    case "approve-session":
    case "session":
      return withOptionalRequestId("approve_session", argument, text);
    case "deny":
    case "reject":
      return withOptionalRequestId("deny", argument, text);
    case "cancel":
    case "stop":
    case "interrupt":
      return { kind: "cancel", raw: text };
    case "status":
    case "state":
      return { kind: "status", raw: text };
    case "help":
      return { kind: "help", raw: text };
    case "允许":
      return withOptionalRequestId("approve", argument, text);
    case "允许本会话":
      return withOptionalRequestId("approve_session", argument, text);
    case "拒绝":
      return withOptionalRequestId("deny", argument, text);
    case "取消":
    case "停止":
    case "中断":
      return { kind: "cancel", raw: text };
    case "状态":
      return { kind: "status", raw: text };
    case "帮助":
      return { kind: "help", raw: text };
    default:
      return { kind: "unknown", raw: text };
  }
}

export function stripLeadingMentions(input: string): string {
  let text = input.trim();
  while (true) {
    const atMention = /^@\d+\s*/u.exec(text);
    if (atMention) {
      text = text.slice(atMention[0].length).trim();
      continue;
    }
    const cqMention = /^\[CQ:at,qq=\d+(?:,[^\]]*)?\]\s*/u.exec(text);
    if (cqMention) {
      text = text.slice(cqMention[0].length).trim();
      continue;
    }
    return text;
  }
}

function withOptionalRequestId(
  kind: "approve" | "approve_session" | "deny",
  requestId: string,
  raw: string,
): ImCommand {
  return requestId ? { kind, requestId, raw } : { kind, raw };
}
