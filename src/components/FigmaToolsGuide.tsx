import type { FigmaConnectionStatus, FigmaTransport } from "../types";

type CatalogTool = {
  name: string;
  title: string;
  description: string;
  files: string;
  availability: "both" | "remote";
  used: boolean;
};

const GROUPS: Array<{ label: string; summary: string; tone: string; tools: CatalogTool[] }> = [
  {
    label: "구조와 시각",
    summary: "선택한 캔버스의 구현 컨텍스트, 구조, 기준 이미지와 모션을 읽습니다.",
    tone: "figma-read",
    tools: [
      { name: "get_design_context", title: "디자인 컨텍스트", description: "선택 노드의 레이아웃·스타일·참조 코드를 반환합니다.", files: "Design", availability: "both", used: true },
      { name: "get_metadata", title: "희소 노드 구조", description: "큰 Design을 ID·타입·위치·크기 중심 XML로 읽습니다.", files: "Design", availability: "both", used: true },
      { name: "get_screenshot", title: "기준 이미지", description: "선택 노드를 PNG로 렌더링해 시각적 기준을 남깁니다.", files: "Design · FigJam", availability: "both", used: true },
      { name: "get_variable_defs", title: "변수와 스타일", description: "색·간격·타입 등 선택 범위에서 사용된 값을 읽습니다.", files: "Design", availability: "both", used: true },
      { name: "get_motion_context", title: "모션 컨텍스트", description: "키프레임, easing, CSS와 motion.dev 힌트를 읽습니다.", files: "Design", availability: "both", used: true },
      { name: "get_figjam", title: "FigJam 구조", description: "FigJam 노드의 XML 구조와 노드 이미지를 반환합니다.", files: "FigJam", availability: "both", used: true },
    ],
  },
  {
    label: "시스템과 자산",
    summary: "코드 컴포넌트 연결, 디자인 라이브러리와 원본 자산을 확인합니다.",
    tone: "figma-system",
    tools: [
      { name: "get_code_connect_map", title: "Code Connect 맵", description: "Figma 인스턴스와 코드 컴포넌트의 연결을 읽습니다.", files: "Design", availability: "both", used: true },
      { name: "get_libraries", title: "연결된 라이브러리", description: "파일이 구독하거나 추가할 수 있는 디자인 라이브러리를 조회합니다.", files: "Design", availability: "remote", used: true },
      { name: "search_design_system", title: "디자인 시스템 검색", description: "라이브러리의 컴포넌트·변수·스타일을 검색합니다.", files: "Design", availability: "remote", used: false },
      { name: "download_assets", title: "자산 다운로드", description: "렌더 export, 원본 이미지와 벡터 SVG를 내려받습니다.", files: "Design · FigJam", availability: "remote", used: true },
      { name: "whoami", title: "계정과 seat", description: "Remote 인증 사용자, 플랜과 seat 정보를 확인합니다.", files: "공통", availability: "remote", used: true },
    ],
  },
  {
    label: "캔버스 쓰기",
    summary: "Figma 콘텐츠를 만들거나 변경하는 Tool입니다. 이 앱은 목록만 보여주고 호출하지 않습니다.",
    tone: "figma-write",
    tools: [
      { name: "use_figma", title: "캔버스 편집", description: "Plugin API 문맥에서 실제 Figma 노드를 만들고 수정합니다.", files: "Design", availability: "remote", used: false },
      { name: "create_new_file", title: "새 파일", description: "Drafts에 새 Design, FigJam 또는 Slides 파일을 만듭니다.", files: "공통", availability: "remote", used: false },
      { name: "upload_assets", title: "자산 업로드", description: "이미지를 Figma 파일에 업로드합니다.", files: "Design", availability: "remote", used: false },
      { name: "generate_diagram", title: "다이어그램 생성", description: "Mermaid 내용을 FigJam 다이어그램으로 만듭니다.", files: "FigJam", availability: "remote", used: false },
      { name: "generate_figma_design", title: "코드에서 캔버스", description: "실행 중인 UI를 편집 가능한 Design 레이어로 보냅니다.", files: "Design", availability: "remote", used: false },
      { name: "add_code_connect_map", title: "Code Connect 쓰기", description: "Figma 노드와 코드 컴포넌트의 새 매핑을 저장합니다.", files: "Design", availability: "both", used: false },
      { name: "send_code_connect_mappings", title: "매핑 일괄 저장", description: "검토된 Code Connect 제안을 한 번에 확정합니다.", files: "Design", availability: "both", used: false },
    ],
  },
];

function normalize(name: string) {
  return name.toLowerCase().replace(/^(?:figma)[-_]/, "").replace(/-/g, "_");
}

export function FigmaToolsGuide({ statuses, transport, onTransportChange }: {
  statuses: Record<FigmaTransport, FigmaConnectionStatus>;
  transport: FigmaTransport;
  onTransportChange: (transport: FigmaTransport) => void;
}) {
  const status = statuses[transport];
  const available = new Set((status.tools ?? []).map((tool) => normalize(tool.name)));
  const hasDiscovery = (status.tools?.length ?? 0) > 0;
  const total = GROUPS.reduce((sum, group) => sum + group.tools.length, 0);
  const known = new Set(GROUPS.flatMap((group) => group.tools.map((tool) => tool.name)));
  const extra = (status.tools ?? []).filter((tool) => !known.has(normalize(tool.name)));

  return (
    <main className="tools-guide figma-tools-guide">
      <section className="tools-hero figma-tools-hero">
        <div><p className="eyebrow">Figma MCP tool map</p><h1>캔버스를 읽는<br />도구의 경계를 봅니다.</h1></div>
        <div className="tools-hero-copy">
          <p>같은 Figma라도 Desktop, Remote, Codex Bridge, Plugin과 파일 유형에 따라 읽기 경로가 달라집니다. 현재 연결에서 실제로 발견한 결과를 정적 지식과 나란히 표시합니다.</p>
          <div className="segmented-control tool-transport" role="group" aria-label="도구 연결 방식">
            {(["desktop", "remote", "codex", "plugin"] as const).map((item) => <button key={item} type="button" className={transport === item ? "active" : ""} onClick={() => onTransportChange(item)}>{item === "desktop" ? "Desktop" : item === "remote" ? "Remote β" : item === "codex" ? "Codex β" : "Plugin"}</button>)}
          </div>
          <dl className="tools-counts"><div><dt>안내 Tool</dt><dd>{total}</dd></div><div><dt>현재 발견</dt><dd>{status.connected && (transport !== "codex" || hasDiscovery) ? status.tools?.length ?? 0 : "—"}</dd></div><div><dt>연결</dt><dd>{status.connected ? "준비됨" : "연결 안 됨"}</dd></div></dl>
        </div>
      </section>

      {!status.connected ? <div className="tools-connection-note figma-note"><strong>{transport === "desktop" ? "Figma Desktop MCP를 켜면 실제 가용 상태가 표시됩니다." : transport === "remote" ? "Remote OAuth 연결 뒤 실제 Tool 범위를 확인할 수 있습니다." : transport === "plugin" ? "Trace Studio에서 만든 6자리 코드로 개발 플러그인을 페어링해 주세요." : "Codex 계정과 Codex의 Figma OAuth를 연결해 주세요."}</strong><span>{status.message}</span></div> : null}

      <div className="tool-groups">
        {GROUPS.map((group) => (
          <section className={`tool-group ${group.tone}`} key={group.label}>
            <header><div><span>{group.label}</span><b>{String(group.tools.length).padStart(2, "0")} tools</b></div><p>{group.summary}</p></header>
            <div className="tool-card-grid">
              {group.tools.map((tool) => {
                const supportedHere = tool.availability === "both" || transport !== "desktop";
                const found = available.has(tool.name);
                return (
                  <article className="tool-card" key={tool.name}>
                    <div className="tool-card-top"><code>{tool.name}</code>{status.connected && (transport !== "codex" || hasDiscovery) ? <span className={`tool-access ${found ? "available" : "blocked"}`}>{found ? "발견됨" : "없음"}</span> : null}</div>
                    <h2>{tool.title}</h2><p>{tool.description}</p>
                    <div className="tool-chips"><span>{tool.files}</span><span>{tool.availability === "remote" ? "Remote · Codex" : "Desktop · Remote · Codex"}</span><span className={tool.used ? "used" : "guide-only"}>{tool.used ? "추출 경로" : "안내만"}</span></div>
                    {!supportedHere ? <small className="tool-unavailable">현재 연결 방식에서는 제공되지 않습니다.</small> : null}
                  </article>
                );
              })}
            </div>
          </section>
        ))}
        {extra.length ? <section className="tool-group discovered"><header><div><span>추가로 발견됨</span><b>{String(extra.length).padStart(2, "0")} tools</b></div><p>{transport === "plugin" ? "현재 개발 플러그인과 REST 이력 연결에서 제공하는 읽기 작업입니다." : "정적 카탈로그보다 현재 MCP 서버가 새로 제공하는 Tool입니다."}</p></header><div className="tool-card-grid">{extra.map((tool) => <article className="tool-card" key={tool.name}><div className="tool-card-top"><code>{tool.name}</code><span className="tool-access available">발견됨</span></div><h2>{transport === "plugin" ? "Plugin 읽기 작업" : "새 MCP Tool"}</h2><p>{tool.description ?? "현재 서버가 반환한 설명이 없습니다."}</p></article>)}</div></section> : null}
      </div>

      <aside className="safety-note figma-safety"><span>Read only</span><strong>추출 페이지는 캔버스를 바꾸지 않습니다.</strong><p>`use_figma`, 파일 생성, 업로드, Code Connect 쓰기 Tool은 안내만 하며 실행 경로에서 호출하지 않습니다. Codex와 Plugin 모드는 각각의 중계 이벤트로 표시됩니다.</p></aside>
    </main>
  );
}
