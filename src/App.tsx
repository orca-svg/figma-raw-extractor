import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { connectPat, disconnect, getStatus, startOAuth, streamExtraction } from "./api";
import { ConnectionPanel } from "./components/ConnectionPanel";
import { DataInspector } from "./components/DataInspector";
import { ExtractionTimeline } from "./components/ExtractionTimeline";
import { ReadPathStrip } from "./components/ReadPathStrip";
import { TargetPanel } from "./components/TargetPanel";
import { ToolsGuide } from "./components/ToolsGuide";
import type { ConnectionStatus, ExtractionEvent, ExtractionOptions } from "./types";

const DEFAULT_TARGET = "";
const DEMO_TARGET = "11111111-1111-4111-8111-111111111111";

const INITIAL_OPTIONS: ExtractionOptions = {
  target: DEFAULT_TARGET,
  expectedEmail: "",
  searchQuery: "오류",
  maxRows: 10,
  includeArchived: true,
  includeComments: true,
  includeTranscript: false,
  mode: "live",
};

type AppView = "trace" | "tools";

function viewFromPath(): AppView {
  return window.location.pathname === "/tools" ? "tools" : "trace";
}

function upsertEvent(events: ExtractionEvent[], next: ExtractionEvent): ExtractionEvent[] {
  const index = events.findIndex((event) => event.id === next.id);
  if (index === -1) return [...events, next].sort((a, b) => a.order - b.order);
  const copy = [...events];
  copy[index] = next;
  return copy;
}

export default function App() {
  const [view, setView] = useState<AppView>(viewFromPath);
  const [status, setStatus] = useState<ConnectionStatus>({ connected: false });
  const [statusLoading, setStatusLoading] = useState(true);
  const [expectedEmail, setExpectedEmail] = useState("");
  const [options, setOptions] = useState(INITIAL_OPTIONS);
  const [events, setEvents] = useState<ExtractionEvent[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string>();
  const controller = useRef<AbortController | undefined>(undefined);

  const refreshStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const next = await getStatus();
      setStatus(next);
      if (next.expectedEmail) setExpectedEmail(next.expectedEmail);
    } catch (error) {
      setStatus({ connected: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    const params = new URLSearchParams(window.location.search);
    if (params.has("auth")) window.history.replaceState({}, "", window.location.pathname);
  }, [refreshStatus]);

  useEffect(() => {
    const onPopState = () => setView(viewFromPath());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const selected = useMemo(() => events.find((event) => event.id === selectedId) ?? events.at(-1), [events, selectedId]);
  const completeEvent = useMemo(() => [...events].reverse().find((event) => event.type === "complete"), [events]);

  const handleOAuth = async () => {
    const authUrl = await startOAuth(expectedEmail);
    window.location.assign(authUrl);
  };

  const handlePat = async (token: string) => {
    const next = await connectPat(expectedEmail, token);
    setStatus(next);
  };

  const handleDisconnect = async () => {
    await disconnect();
    setStatus({ connected: false });
    setEvents([]);
    setSelectedId(undefined);
  };

  const handleEvent = (event: ExtractionEvent) => {
    setEvents((current) => upsertEvent(current, event));
    setSelectedId((current) => current ?? event.id);
  };

  const run = async (mode: "live" | "demo") => {
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    setEvents([]);
    setSelectedId(undefined);
    setRunError(undefined);
    setRunning(true);
    try {
      await streamExtraction({
        ...options,
        target: mode === "demo" ? DEMO_TARGET : options.target,
        expectedEmail: mode === "demo" ? "demo@notion.local" : expectedEmail,
        mode,
      }, handleEvent, nextController.signal);
    } catch (error) {
      if (!nextController.signal.aborted) setRunError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!nextController.signal.aborted) setRunning(false);
    }
  };

  const navigate = (next: AppView) => (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    const path = next === "tools" ? "/tools" : "/";
    if (window.location.pathname !== path) window.history.pushState({}, "", path);
    setView(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand-lockup" href="/" onClick={navigate("trace")} aria-label="Notion MCP Trace 홈">
          <span className="brand-mark" aria-hidden="true">N</span><span><b>Notion MCP Trace</b><small>local read inspector</small></span>
        </a>
        <div className="header-actions">
          <nav className="site-nav" aria-label="주요 메뉴">
            <a className={view === "trace" ? "active" : ""} href="/" onClick={navigate("trace")} aria-current={view === "trace" ? "page" : undefined}>추출 검사</a>
            <a className={view === "tools" ? "active" : ""} href="/tools" onClick={navigate("tools")} aria-current={view === "tools" ? "page" : undefined}>MCP 도구 안내</a>
          </nav>
          <div className="header-state">
            <span className={`status-dot ${status.connected ? "success" : "idle"}`} />
            {statusLoading ? "연결 확인 중" : status.connected ? `${status.identity?.workspace?.name}에 연결됨` : "연결 안 됨"}
          </div>
        </div>
      </header>

      {view === "tools" ? <ToolsGuide status={status} /> : <><section className="intro">
        <p className="eyebrow">계정부터 원시 응답까지</p>
        <h1>Notion에서 어디까지<br />읽혔는지 바로 확인합니다.</h1>
        <p>계정과 페이지를 정하면 MCP 호출이 순서대로 쌓입니다. 실패한 지점, 건너뛴 단계, 반환된 원문을 숨기지 않습니다.</p>
      </section>

      <ReadPathStrip />

      {completeEvent ? (
        <section className={`completion-bar ${completeEvent.state}`}>
          <div><span>마지막 실행</span><strong>{completeEvent.message}</strong></div>
          <button type="button" onClick={() => setSelectedId(completeEvent.id)}>결과 열기</button>
        </section>
      ) : null}
      {runError ? <div className="page-error" role="alert">{runError}</div> : null}

      <main className="workspace">
        <aside className="setup-column">
          <ConnectionPanel
            status={status}
            expectedEmail={expectedEmail}
            onExpectedEmailChange={setExpectedEmail}
            onOAuth={handleOAuth}
            onPat={handlePat}
            onDisconnect={handleDisconnect}
            busy={running || statusLoading}
          />
          <TargetPanel options={options} onChange={setOptions} onRun={(mode) => void run(mode)} running={running} connected={status.connected} />
        </aside>
        <ExtractionTimeline events={events} selectedId={selected?.id} onSelect={(event) => setSelectedId(event.id)} running={running} />
        <DataInspector event={selected} />
      </main>
      </>}

      <footer>
        <p>토큰은 서버 메모리에만 저장됩니다. 쓰기 도구는 호출하지 않습니다.</p>
        <div><a href="https://developers.notion.com/guides/mcp/build-mcp-client" target="_blank" rel="noreferrer">Notion MCP 연결 문서</a><a href="https://developers.notion.com/guides/mcp/mcp-supported-tools" target="_blank" rel="noreferrer">지원 도구</a></div>
      </footer>
    </div>
  );
}
