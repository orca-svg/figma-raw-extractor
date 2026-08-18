import { unzipSync, strFromU8 } from "fflate";
import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { FigmaDemoAdapter, FIGMA_DEMO_TARGET } from "../server/figma-demo-adapter.js";
import { runFigmaExtraction } from "../server/figma-extract.js";
import { buildFigmaRunZip, createFigmaRun, upsertRunEvent } from "../server/figma-run-store.js";
import { parseFigmaTarget } from "../server/figma-target.js";
import type { ExtractionEvent, FigmaExtractionInput, McpAdapter, ToolDescriptor } from "../server/types.js";

const baseInput: FigmaExtractionInput = {
  target: FIGMA_DEMO_TARGET,
  targetMode: "link",
  transport: "desktop",
  includeVariables: true,
  includeCodeConnect: true,
  includeMotion: true,
  includeLibraries: false,
  includeAssets: false,
  clientFrameworks: "unknown",
  clientLanguages: "unknown",
  mode: "demo",
};

describe("Figma target parser", () => {
  it("Design, branch, FigJam 링크를 file key와 node id로 정규화한다", () => {
    expect(parseFigmaTarget("https://www.figma.com/design/abc/File?node-id=12-34")).toMatchObject({ fileKey: "abc", nodeId: "12:34", fileType: "design" });
    expect(parseFigmaTarget("https://figma.com/design/base/branch/branchKey/File?node-id=8%3A9")).toMatchObject({ fileKey: "branchKey", nodeId: "8:9", fileType: "design" });
    expect(parseFigmaTarget("https://www.figma.com/board/jamKey/Map?node-id=1-2")).toMatchObject({ fileKey: "jamKey", nodeId: "1:2", fileType: "figjam" });
  });

  it("파일 전체 링크와 지원하지 않는 유형을 거부한다", () => {
    expect(() => parseFigmaTarget("https://figma.com/design/abc/File")).toThrow(/node-id/);
    expect(() => parseFigmaTarget("https://figma.com/slides/abc/Deck?node-id=1-2")).toThrow(/지원하지/);
  });
});

describe("Figma extraction pipeline", () => {
  it("Design 예제의 읽기 Tool을 추적하고 screenshot을 artifact로 분리한다", async () => {
    const run = createFigmaRun("test-session", baseInput);
    const adapter = new FigmaDemoAdapter();
    await runFigmaExtraction(adapter, baseInput, run, (event) => upsertRunEvent(run, event));

    const tools = run.events.filter((event) => event.tool).map((event) => event.tool);
    expect(tools).toContain("get_design_context");
    expect(tools).toContain("get_screenshot");
    expect(tools).toContain("get_variable_defs");
    expect(tools).toContain("get_code_connect_map");
    expect(tools).toContain("get_motion_context");
    expect(run.detectedFileType).toBe("design");
    expect(run.artifacts.size).toBeGreaterThan(0);
    expect(run.events.at(-1)?.type).toBe("complete");
    expect(run.events.every((event) => event.provider === "figma" && event.runId === run.id)).toBe(true);

    const screenshot = run.events.find((event) => event.group === "screenshot");
    expect(screenshot?.artifacts?.[0].mimeType).toBe("image/svg+xml");
    expect(JSON.stringify(screenshot?.response)).not.toContain("PHN2Zy");

    const zip = unzipSync(buildFigmaRunZip(run));
    expect(Object.keys(zip)).toContain("manifest.json");
    expect(Object.keys(zip)).toContain("trace.ndjson");
    expect(Object.keys(zip)).toContain("README.md");
    expect(Object.keys(zip).some((name) => name.startsWith("responses/") && name.includes("get_screenshot"))).toBe(true);
    expect(Object.keys(zip).some((name) => name.startsWith("artifacts/screenshots/"))).toBe(true);
    expect(JSON.parse(strFromU8(zip["manifest.json"])).provider).toBe("figma");
  });

  it("Desktop 현재 선택이 Design 유형 오류를 내면 FigJam으로 전환한다", async () => {
    const calls: string[] = [];
    const text = (value: string, isError = false): CallToolResult => ({ content: [{ type: "text", text: value }], isError });
    const adapter: McpAdapter = {
      async listTools(): Promise<ToolDescriptor[]> {
        return [{ name: "get_design_context" }, { name: "get_figjam" }, { name: "get_screenshot" }];
      },
      async callTool(name): Promise<CallToolResult> {
        calls.push(name);
        if (name === "get_design_context") return text("This is a FigJam board and is not supported by the Design tool.", true);
        if (name === "get_figjam") return text("<figjam><sticky id=\"1:2\">Flow</sticky></figjam>");
        return text("screenshot-url");
      },
      async close() {},
    };
    const input: FigmaExtractionInput = { ...baseInput, target: "", targetMode: "selection", mode: "live" };
    const run = createFigmaRun("test-session", input);
    const events: ExtractionEvent[] = [];
    await runFigmaExtraction(adapter, input, run, (event) => { events.push(event); upsertRunEvent(run, event); });

    expect(calls.slice(0, 2)).toEqual(["get_design_context", "get_figjam"]);
    expect(run.detectedFileType).toBe("figjam");
    expect(events.some((event) => event.group === "figjam" && event.state === "success")).toBe(true);
  });
});
