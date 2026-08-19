import { describe, expect, it } from "vitest";
import {
  extractAttachments,
  extractDataSourceUrls,
  extractDiscussionUrls,
  extractIdentity,
  extractPageTargets,
  extractViewUrls,
  parseToolResult,
  resolveTool,
} from "../server/extract.js";
import { parseNotionTarget } from "../server/notion-target.js";

describe("Notion MCP 응답 파서", () => {
  it("Enhanced Markdown에서 데이터 소스, 뷰, 댓글, 첨부를 분리한다", () => {
    const payload = {
      text: [
        '<data-source url="collection://f336d0bc-b841-465b-8045-024475c079dd">Tasks</data-source>',
        '<view url="https://www.notion.so/f336d0bcb841465b8045024475c079dd?v=1234567890abcdef1234567890abcdef">All</view>',
        '<view url="{{view://12345678-90ab-cdef-1234-567890abcdef}}">Configured</view>',
        '<discussion url="discussion://page/block/thread"/>',
        '<file src="https://files.example.com/report.csv">report.csv</file>',
      ].join("\n"),
    };
    expect(extractDataSourceUrls(payload)).toEqual(["collection://f336d0bc-b841-465b-8045-024475c079dd"]);
    expect(extractViewUrls(payload)).toEqual(["view://12345678-90ab-cdef-1234-567890abcdef"]);
    expect(extractDiscussionUrls(payload)).toEqual(["discussion://page/block/thread"]);
    expect(extractAttachments(payload)).toEqual([{ kind: "file", url: "https://files.example.com/report.csv" }]);
  });

  it("query 결과에서 페이지 대상만 고른다", () => {
    const payload = {
      results: [
        { id: "11111111-1111-4111-8111-111111111111", url: "https://www.notion.so/11111111111141118111111111111111", 이름: "실제 SQL 응답 형태" },
        { url: "https://app.notion.com/p/33333333333343338333333333333333", 이름: "실제 뷰 응답 형태" },
        { object: "user", id: "22222222-2222-4222-8222-222222222222" },
      ],
    };
    expect(extractPageTargets(payload)).toEqual([
      "https://www.notion.so/11111111111141118111111111111111",
      "https://app.notion.com/p/33333333333343338333333333333333",
    ]);
  });

  it("self 응답과 OpenAI식 도구 이름을 정규화한다", () => {
    const result = parseToolResult({
      content: [{ type: "text", text: JSON.stringify({ self: { workspace: { name: "Example Workspace" }, user: { email: "name@example.com" }, current_tool_access: { fetch: { status: "available" } } } }) }],
    });
    expect(extractIdentity(result.payload).workspace?.name).toBe("Example Workspace");
    expect(resolveTool([{ name: "fetch" }, { name: "notion-query-data-sources" }], "query_data_sources")).toBe("notion-query-data-sources");
    expect(resolveTool([{ name: "figma_get_design_context" }], "get_design_context")).toBe("figma_get_design_context");
  });
});

describe("Notion 타겟 파서", () => {
  it("워크스페이스와 제목이 붙은 링크에서 페이지 ID를 뽑는다", () => {
    expect(parseNotionTarget("https://www.notion.so/acme/Team-Home-f336d0bcb841465b8045024475c079dd")).toMatchObject({
      kind: "page",
      pageId: "f336d0bc-b841-465b-8045-024475c079dd",
    });
  });

  it("?v= 가 붙으면 데이터베이스 뷰로 본다", () => {
    expect(parseNotionTarget("https://www.notion.so/11111111111141118111111111111111?v=22222222222242228222222222222222")).toMatchObject({
      kind: "database",
      pageId: "11111111-1111-4111-8111-111111111111",
      viewId: "22222222-2222-4222-8222-222222222222",
    });
  });

  it("ID만 붙여넣으면 표준 URL로 편다", () => {
    expect(parseNotionTarget("11111111-1111-4111-8111-111111111111")).toMatchObject({
      kind: "page",
      pageId: "11111111-1111-4111-8111-111111111111",
      sourceUrl: "https://www.notion.so/11111111111141118111111111111111",
    });
  });

  it("notion.site 공개 링크도 받는다", () => {
    expect(parseNotionTarget("https://acme.notion.site/Docs-f336d0bcb841465b8045024475c079dd")).toMatchObject({
      pageId: "f336d0bc-b841-465b-8045-024475c079dd",
    });
  });

  it("다른 호스트와 ID 없는 링크는 거부한다", () => {
    expect(() => parseNotionTarget("https://example.com/f336d0bcb841465b8045024475c079dd")).toThrow(/notion/);
    expect(() => parseNotionTarget("https://www.notion.so/acme/Team-Home")).toThrow(/페이지 ID/);
    expect(() => parseNotionTarget("   ")).toThrow(/입력/);
  });
});
