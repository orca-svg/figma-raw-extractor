import { useMemo, useState } from "react";
import type { ExtractionEvent } from "../types";

type Tab = "extracted" | "request" | "response";

function JsonBlock({ value }: { value: unknown }) {
  const text = useMemo(() => {
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }, [value]);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div className="json-wrap">
      <button type="button" className="copy-button" onClick={() => void copy()}>{copied ? "복사됨" : "복사"}</button>
      <pre>{text || "표시할 값이 없습니다."}</pre>
    </div>
  );
}

export function DataInspector({ event }: { event?: ExtractionEvent }) {
  const [tab, setTab] = useState<Tab>("extracted");
  if (!event) {
    return (
      <aside className="inspector empty-inspector">
        <p className="eyebrow">응답 판독</p>
        <h2>호출을 선택하세요</h2>
        <p>실행 기록에서 한 단계를 누르면 실제 요청과 반환값을 그대로 볼 수 있습니다.</p>
      </aside>
    );
  }
  const value = tab === "extracted" ? event.extracted ?? event.message : tab === "request" ? event.request : event.response;
  return (
    <aside className="inspector" aria-labelledby="inspector-title">
      <div className="inspector-head">
        <div>
          <p className="eyebrow">응답 판독 · {String(event.order).padStart(2, "0")}</p>
          <h2 id="inspector-title">{event.label}</h2>
        </div>
        <span className={`state-label ${event.state}`}>{event.state}</span>
      </div>
      <div className="tabs" role="tablist" aria-label="응답 보기 방식">
        {(["extracted", "request", "response"] as const).map((name) => (
          <button key={name} type="button" role="tab" aria-selected={tab === name} className={tab === name ? "active" : ""} onClick={() => setTab(name)}>
            {name === "extracted" ? "추출 정보" : name === "request" ? "MCP 입력" : "원시 응답"}
          </button>
        ))}
      </div>
      <JsonBlock value={value} />
      <dl className="call-facts">
        <div><dt>도구</dt><dd>{event.tool ?? "내부 처리"}</dd></div>
        <div><dt>시작</dt><dd>{new Date(event.startedAt).toLocaleTimeString("ko-KR")}</dd></div>
        <div><dt>소요</dt><dd>{typeof event.elapsedMs === "number" ? `${event.elapsedMs}ms` : "—"}</dd></div>
      </dl>
    </aside>
  );
}
