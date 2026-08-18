import { describe, expect, it } from "vitest";
import { figmaPreviewUrls } from "../src/lib/figma-preview-urls.js";

describe("DataInspector Figma preview URL parser", () => {
  it("response가 없는 skipped 이벤트를 빈 URL 목록으로 처리한다", () => {
    expect(figmaPreviewUrls(undefined)).toEqual([]);
  });

  it("Figma MCP asset 이미지만 중복 없이 반환한다", () => {
    const url = "https://www.figma.com/api/mcp/asset/example.png";
    expect(figmaPreviewUrls({ first: url, duplicate: url, unrelated: "https://example.com/image.png" })).toEqual([url]);
  });
});
