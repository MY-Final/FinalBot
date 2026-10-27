import { describe, expect, test } from "bun:test";
import { extractText } from "./index";

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

