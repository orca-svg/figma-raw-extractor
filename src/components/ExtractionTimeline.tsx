import type { ExtractionEvent } from "../types";

const GROUP_NAMES: Record<ExtractionEvent["group"], string> = {
  connection: "연결",
  discovery: "도구",
  search: "검색",
  target: "대상",
  schema: "스키마",
  view: "뷰",
  sql: "SQL",
  page: "본문",
  comments: "댓글",
  summary: "완료",
};

type Props = {
  events: ExtractionEvent[];
  selectedId?: string;
  onSelect: (event: ExtractionEvent) => void;
  running: boolean;
};

export function ExtractionTimeline({ events, selectedId, onSelect, running }: Props) {
  return (
    <section className="trace" aria-labelledby="trace-title" aria-live="polite">
      <div className="trace-heading">
        <div>
          <p className="eyebrow">실행 기록</p>
          <h2 id="trace-title">MCP가 읽는 순서</h2>
        </div>
        <span className={`run-state ${running ? "active" : ""}`}><i />{running ? "실행 중" : events.length ? "실행 종료" : "대기"}</span>
      </div>
      {events.length === 0 ? (
        <div className="empty-trace">
          <span className="empty-signal" aria-hidden="true" />
          <p>계정과 대상을 정한 뒤 실행하세요.</p>
          <small>각 호출의 입력, 응답, 걸린 시간이 이 선을 따라 쌓입니다.</small>
        </div>
      ) : (
        <ol className="timeline">
          {events.map((event) => (
            <li key={event.id} className={`timeline-item ${event.state}`}>
              <button type="button" className={`event-card ${selectedId === event.id ? "selected" : ""}`} onClick={() => onSelect(event)}>
                <span className="event-index">{String(event.order).padStart(2, "0")}</span>
                <span className="event-copy">
                  <span className="event-meta"><b>{GROUP_NAMES[event.group]}</b>{event.tool ? <code>{event.tool}</code> : null}</span>
                  <strong>{event.label}</strong>
                  {event.message ? <small>{event.message}</small> : null}
                </span>
                <span className="event-result">
                  <span className={`state-label ${event.state}`}>{event.state === "running" ? "진행" : event.state === "success" ? "완료" : event.state === "warning" ? "확인" : event.state === "error" ? "오류" : "건너뜀"}</span>
                  {typeof event.elapsedMs === "number" ? <time>{event.elapsedMs}ms</time> : null}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
