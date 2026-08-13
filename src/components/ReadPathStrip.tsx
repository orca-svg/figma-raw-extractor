const PATHS = [
  ["tools/list", "현재 연결에서 쓸 수 있는 도구"],
  ["fetch · self", "계정·워크스페이스·플랜 권한"],
  ["search", "워크스페이스 의미 검색"],
  ["fetch · target", "페이지·DB 본문과 데이터 소스"],
  ["fetch · collection", "속성 스키마와 템플릿"],
  ["query · view", "뷰 필터를 적용한 활성·보관 행"],
  ["legacy view", "구형 query_database_view 연결 호환"],
  ["query · SQL", "데이터 소스 전체 속성"],
  ["fetch · row", "각 행의 본문·누락 블록·첨부 표식"],
  ["get_comments", "페이지·블록 댓글과 해결된 토론"],
] as const;

export function ReadPathStrip() {
  return (
    <details className="path-strip">
      <summary><span>구현된 읽기 경로</span><b>{PATHS.length}가지</b></summary>
      <div className="path-grid">
        {PATHS.map(([tool, copy], index) => (
          <div className="path-item" key={tool}><span>{String(index + 1).padStart(2, "0")}</span><code>{tool}</code><p>{copy}</p></div>
        ))}
      </div>
      <p className="path-footnote">Notion MCP가 제공하지 않는 임의 첨부파일 다운로드는 실행하지 않습니다. 본문에 반환된 첨부 URL과 메타데이터까지만 기록합니다.</p>
    </details>
  );
}
