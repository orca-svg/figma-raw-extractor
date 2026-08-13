import { describe, expect, it } from "vitest";
import { DemoMcpAdapter } from "../server/demo-adapter.js";
import { runExtraction } from "../server/extract.js";
import type { ExtractionEvent, ExtractionInput } from "../server/types.js";

const baseInput: ExtractionInput = {
  target: "https://www.notion.so/11111111111141118111111111111111?v=22222222222242228222222222222222",
  expectedEmail: "demo@notion.local",
  searchQuery: "오류",
  maxRows: 3,
  includeArchived: true,
  includeComments: true,
  includeTranscript: false,
  mode: "demo",
};

async function collect(input: ExtractionInput): Promise<ExtractionEvent[]> {
  const adapter = await DemoMcpAdapter.create();
  const events: ExtractionEvent[] = [];
  try {
    await runExtraction(adapter, input, (event) => {
      const index = events.findIndex((current) => current.id === event.id);
      if (index === -1) events.push(event);
      else events[index] = event;
    });
    return events;
  } finally {
    await adapter.close();
  }
}

describe("단계별 추출 파이프라인", () => {
  it("모든 읽기 경로를 실행하고 26행 fixture에서 선택한 수만큼 본문을 읽는다", async () => {
    const events = await collect(baseInput);
    const groups = new Set(events.map((event) => event.group));
    for (const group of ["discovery", "connection", "search", "target", "schema", "view", "sql", "page", "comments", "summary"]) {
      expect(groups.has(group as ExtractionEvent["group"]), `${group} 단계 누락`).toBe(true);
    }
    expect(events.some((event) => event.group === "view" && event.label.includes("활성"))).toBe(true);
    expect(events.some((event) => event.group === "view" && event.label.includes("보관"))).toBe(true);
    expect(events.some((event) => event.group === "sql")).toBe(true);
    expect(events.filter((event) => event.group === "page" && event.state === "success")).toHaveLength(3);
    expect(events.at(-1)?.type).toBe("complete");
  }, 20_000);

  it("대상 접근 실패를 오류로 남기고 종속 단계를 건너뛴다", async () => {
    const events = await collect({ ...baseInput, target: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    expect(events.find((event) => event.group === "target")?.state).toBe("error");
    for (const group of ["schema", "view", "sql", "page", "comments"]) {
      expect(events.find((event) => event.group === group)?.state).toBe("skipped");
    }
    expect(events.at(-1)?.state).toBe("warning");
  }, 10_000);

  it("입력 이메일과 연결 이메일이 다르면 대상 조회 전에 멈춘다", async () => {
    const events = await collect({ ...baseInput, expectedEmail: "wrong@example.com" });
    expect(events.some((event) => event.type === "fatal" && event.group === "connection")).toBe(true);
    expect(events.some((event) => event.group === "target")).toBe(false);
  });
});
