import type { FigmaExtractionOptions } from "../types";

type Props = {
  options: FigmaExtractionOptions;
  onChange: (options: FigmaExtractionOptions) => void;
  onRun: (mode: "live" | "demo") => void;
  running: boolean;
  connected: boolean;
};

function Toggle({ checked, disabled, onChange, children }: { checked: boolean; disabled?: boolean; onChange: (value: boolean) => void; children: React.ReactNode }) {
  return (
    <label className={`toggle-row ${disabled ? "disabled" : ""}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span className="toggle-track" aria-hidden="true"><span /></span><span>{children}</span>
    </label>
  );
}

function detectedType(target: string) {
  if (/figma\.com\/design\//i.test(target)) return "Figma Design";
  if (/figma\.com\/board\//i.test(target)) return "FigJam";
  if (/figma\.com\/(?:slides|make)\//i.test(target)) return "지원하지 않는 유형";
  return "링크 입력 대기";
}

export function FigmaTargetPanel({ options, onChange, onRun, running, connected }: Props) {
  const patch = (next: Partial<FigmaExtractionOptions>) => onChange({ ...options, ...next });
  const canRun = connected && (options.targetMode === "selection" ? options.transport === "desktop" : Boolean(options.target));
  return (
    <section className="panel target-panel figma-target" aria-labelledby="figma-target-title">
      <div className="panel-heading">
        <span className="section-mark">B</span>
        <div><p className="eyebrow">Canvas target</p><h2 id="figma-target-title">읽을 노드</h2></div>
      </div>

      <div className="target-mode-row">
        <div className="segmented-control compact" role="group" aria-label="Figma 대상 지정 방식">
          <button type="button" className={options.targetMode === "link" ? "active" : ""} aria-pressed={options.targetMode === "link"} onClick={() => patch({ targetMode: "link" })}>노드 링크</button>
          <button type="button" disabled={options.transport !== "desktop"} className={options.targetMode === "selection" ? "active" : ""} aria-pressed={options.targetMode === "selection"} onClick={() => patch({ targetMode: "selection" })}>현재 선택</button>
        </div>
        <span className={`detected-chip ${detectedType(options.target).includes("지원하지") ? "error" : ""}`}>{options.targetMode === "selection" ? "자동 감지" : detectedType(options.target)}</span>
      </div>

      {options.targetMode === "link" ? (
        <label className="field">
          <span>프레임 또는 레이어 링크</span>
          <textarea value={options.target} onChange={(event) => patch({ target: event.target.value })} rows={3} spellCheck={false} placeholder="https://www.figma.com/design/…?node-id=1-2" />
          <small>file key와 node-id를 읽습니다. 파일 전체 링크는 실행하지 않습니다.</small>
        </label>
      ) : (
        <div className="selection-well"><span className="selection-crosshair" aria-hidden="true" /><strong>Figma의 현재 선택을 사용합니다.</strong><p>실행 시 Design을 먼저 확인하고 파일 유형 오류일 때 FigJam으로 전환합니다.</p></div>
      )}

      <details className="advanced-options">
        <summary>고급 Tool 옵션</summary>
        <div className="two-fields">
          <label className="field compact"><span>Frameworks</span><input value={options.clientFrameworks} onChange={(event) => patch({ clientFrameworks: event.target.value })} placeholder="unknown" /></label>
          <label className="field compact"><span>Languages</span><input value={options.clientLanguages} onChange={(event) => patch({ clientLanguages: event.target.value })} placeholder="unknown" /></label>
        </div>
        <label className="field compact"><span>Code Connect label</span><input value={options.codeConnectLabel ?? ""} onChange={(event) => patch({ codeConnectLabel: event.target.value })} placeholder="예: React, SwiftUI" /></label>
        <div className="toggle-list">
          <Toggle checked={options.includeVariables} onChange={(value) => patch({ includeVariables: value })}>변수와 스타일</Toggle>
          <Toggle checked={options.includeCodeConnect} onChange={(value) => patch({ includeCodeConnect: value })}>Code Connect</Toggle>
          <Toggle checked={options.includeMotion} onChange={(value) => patch({ includeMotion: value })}>하위 모션</Toggle>
          <Toggle checked={options.includeLibraries} disabled={options.transport !== "remote"} onChange={(value) => patch({ includeLibraries: value })}>Remote 라이브러리</Toggle>
          <Toggle checked={options.includeAssets} disabled={options.transport !== "remote"} onChange={(value) => patch({ includeAssets: value })}>Remote 자산 다운로드</Toggle>
        </div>
      </details>

      <button className="primary-button figma-primary full" type="button" onClick={() => onRun("live")} disabled={!canRun || running}>
        {running ? "Tool 호출 추적 중" : connected ? "실제 Figma MCP로 읽기" : `${options.transport === "desktop" ? "Desktop" : "Remote"} 연결을 확인하세요`}
      </button>
      <button className="demo-button figma-demo full" type="button" onClick={() => onRun("demo")} disabled={running}>Design 예제로 전체 여정 보기</button>
      <p className="demo-note">예제는 합성 Design 응답이며 FigJam 예제는 제공하지 않습니다.</p>
    </section>
  );
}
