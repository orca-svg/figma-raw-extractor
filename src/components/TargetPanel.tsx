import type { ExtractionOptions } from "../types";

type Props = {
  options: ExtractionOptions;
  onChange: (next: ExtractionOptions) => void;
  onRun: (mode: "live" | "demo") => void;
  running: boolean;
  connected: boolean;
};

function Toggle({ checked, onChange, children }: { checked: boolean; onChange: (value: boolean) => void; children: React.ReactNode }) {
  return (
    <label className="toggle-row">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="toggle-track" aria-hidden="true"><span /></span>
      <span>{children}</span>
    </label>
  );
}

export function TargetPanel({ options, onChange, onRun, running, connected }: Props) {
  const patch = (next: Partial<ExtractionOptions>) => onChange({ ...options, ...next });
  return (
    <section className="panel target-panel" aria-labelledby="target-title">
      <div className="panel-heading">
        <span className="section-mark">02</span>
        <div>
          <p className="eyebrow">대상</p>
          <h2 id="target-title">가져올 파일</h2>
        </div>
      </div>
      <label className="field">
        <span>Notion 페이지·데이터베이스 URL 또는 ID</span>
        <textarea value={options.target} onChange={(event) => patch({ target: event.target.value })} rows={3} spellCheck={false} />
      </label>
      <div className="two-fields">
        <label className="field compact">
          <span>검색어</span>
          <input value={options.searchQuery ?? ""} onChange={(event) => patch({ searchQuery: event.target.value })} placeholder="예: 오류, 회의록" />
        </label>
        <label className="field compact">
          <span>최대 행</span>
          <input type="number" min={1} max={50} value={options.maxRows} onChange={(event) => patch({ maxRows: Number(event.target.value) })} />
        </label>
      </div>
      <div className="toggle-list">
        <Toggle checked={options.includeArchived} onChange={(value) => patch({ includeArchived: value })}>보관된 행도 확인</Toggle>
        <Toggle checked={options.includeComments} onChange={(value) => patch({ includeComments: value })}>댓글과 토론 확인</Toggle>
        <Toggle checked={options.includeTranscript} onChange={(value) => patch({ includeTranscript: value })}>회의록 전사 포함</Toggle>
      </div>
      <button className="primary-button full" type="button" onClick={() => onRun("live")} disabled={!connected || !options.target || running}>
        {running ? "읽는 중" : connected ? "실제 MCP로 읽기" : "계정을 먼저 연결하세요"}
      </button>
      <button className="demo-button full" type="button" onClick={() => onRun("demo")} disabled={running}>
        26행 예제로 먼저 보기
      </button>
      <p className="demo-note">예제 모드는 로컬 CSV를 MCP 응답 형태로 재생합니다. 실제 조회 결과와 섞이지 않습니다.</p>
    </section>
  );
}
