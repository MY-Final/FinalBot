import { describe, expect, test } from "bun:test";
import { extractText, isGroupMention, isSelfAuthoredEvent } from "./index";

describe("OneBot text extraction", () => {
  test("keeps text and identifies media", () => {
    expect(
      extractText([
        { type: "text", data: { text: "看一下 " } },
        { type: "image", data: { url: "https://example.com/a.png" } },
        { type: "text", data: { text: " 这个问题" } },
      ]),
    ).toBe("看一下 [图片] 这个问题");
  });

  test("handles plain string messages", () => {
    expect(extractText("hello")).toBe("hello");
  });
});

describe("OneBot self-message filtering", () => {
  test("detects messages sent by the connected account", () => {
    expect(
      isSelfAuthoredEvent({
        self_id: 3430269738,
        user_id: 3430269738,
      }),
    ).toBe(true);
  });

  test("does not discard messages from other group members", () => {
    expect(
      isSelfAuthoredEvent({
      self_id: 3430269738,
        user_id: 479284441,
      }),
    ).toBe(false);
  });
});

describe("OneBot group mention routing", () => {
  test("accepts a group message that mentions the bot", () => {
    expect(
      isGroupMention(
        {
          message: [
            { type: "at", data: { qq: "479284441" } },
            { type: "text", data: { text: " hello" } },
          ],
        },
        "479284441",
      ),
    ).toBe(true);
  });

  test("rejects an unmentioned group message", () => {
    expect(
      isGroupMention(
        {
          message: [{ type: "text", data: { text: "ordinary group chat" } }],
        },
        "479284441",
      ),
    ).toBe(false);
  });

  test("supports CQ-encoded mentions in raw messages", () => {
    expect(
      isGroupMention(
        {
          raw_message: "[CQ:at,qq=479284441] hello",
        },
        "479284441",
      ),
    ).toBe(true);
  });
});

