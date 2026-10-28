export type ImCommand =
  | {
      kind: "approve" | "approve_session" | "deny";
      raw: string;
      requestId?: string;
    }
  | {
      kind: "use";
      raw: string;
      bot: string;
    }
  | {
      kind: "bot";
      raw: string;
      bot: string;
      prompt: string;
    }
  | {
      kind: "bots" | "cancel" | "status" | "help" | "unknown";
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
      return argument ? { kind: "unknown", raw: text } : { kind: "cancel", raw: text };
    case "status":
    case "state":
      return argument ? { kind: "unknown", raw: text } : { kind: "status", raw: text };
    case "help":
      return argument ? { kind: "unknown", raw: text } : { kind: "help", raw: text };
    case "bots":
    case "botlist":
      return argument ? { kind: "unknown", raw: text } : { kind: "bots", raw: text };
    case "use":
      return argument && !/\s/.test(argument)
        ? { kind: "use", bot: argument, raw: text }
        : { kind: "unknown", raw: text };
    case "bot":
      return parseBotDispatch(argument, text);
    case "允许":
      return withOptionalRequestId("approve", argument, text);
    case "允许本会话":
      return withOptionalRequestId("approve_session", argument, text);
    case "拒绝":
      return withOptionalRequestId("deny", argument, text);
    case "取消":
    case "停止":
    case "中断":
      return argument ? { kind: "unknown", raw: text } : { kind: "cancel", raw: text };
    case "状态":
      return argument ? { kind: "unknown", raw: text } : { kind: "status", raw: text };
    case "帮助":
      return argument ? { kind: "unknown", raw: text } : { kind: "help", raw: text };
    case "机器人":
      return argument ? { kind: "unknown", raw: text } : { kind: "bots", raw: text };
    case "使用":
      return argument && !/\s/.test(argument)
        ? { kind: "use", bot: argument, raw: text }
        : { kind: "unknown", raw: text };
    case "派发":
      return parseBotDispatch(argument, text);
    default:
      return { kind: "unknown", raw: text };
  }
}

function parseBotDispatch(argument: string, raw: string): ImCommand {
  const match = /^(\S+)\s+([\s\S]+)$/.exec(argument);
  if (!match?.[1] || !match[2]?.trim()) {
    return { kind: "unknown", raw };
  }
  return {
    kind: "bot",
    bot: match[1],
    prompt: match[2].trim(),
    raw,
  };
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
  if (/\s/.test(requestId)) return { kind: "unknown", raw };
  return requestId ? { kind, requestId, raw } : { kind, raw };
}
