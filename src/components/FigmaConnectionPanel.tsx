import { useState } from "react";
import type { FigmaConnectionStatus, FigmaTransport } from "../types";

type Props = {
  statuses: Record<FigmaTransport, FigmaConnectionStatus>;
  transport: FigmaTransport;
  onTransportChange: (transport: FigmaTransport) => void;
  onRefresh: (transport: FigmaTransport) => Promise<void>;
  onOAuth: () => Promise<void>;
  onDisconnect: () => Promise<void>;
  busy: boolean;
};

function identityLabel(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["email", "handle", "name"]) if (typeof record[key] === "string") return record[key];
  for (const child of Object.values(record)) {
    const found = identityLabel(child);
    if (found) return found;
  }
  return undefined;
}

export function FigmaConnectionPanel({ statuses, transport, onTransportChange, onRefresh, onOAuth, onDisconnect, busy }: Props) {
  const [error, setError] = useState<string>();
  const status = statuses[transport];
  const handle = async (action: () => Promise<void>) => {
    setError(undefined);
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <section className="panel connection-panel figma-connection" aria-labelledby="figma-connection-title">
      <div className="panel-heading">
        <span className="section-mark">A</span>
        <div><p className="eyebrow">Connection</p><h2 id="figma-connection-title">Figma 연결</h2></div>
      </div>
      <div className="segmented-control" role="group" aria-label="Figma MCP 연결 방식">
        {(["desktop", "remote"] as const).map((item) => (
          <button key={item} type="button" className={transport === item ? "active" : ""} aria-pressed={transport === item} onClick={() => onTransportChange(item)}>
            {item === "desktop" ? "Desktop" : "Remote β"}
          </button>
        ))}
      </div>

      {status.connected ? (
        <div className="connected-card figma-card">
          <div className="connected-line"><span className="status-dot success" /><strong>{transport === "desktop" ? "Figma Desktop 준비됨" : identityLabel(status.identity) ?? "Figma Remote 연결됨"}</strong></div>
          <p>{status.tools?.length ?? 0}개 MCP Tool을 확인했습니다.</p>
          <p className="small-copy">{transport === "desktop" ? "127.0.0.1:3845 · 현재 앱/선택 사용 가능" : "Remote OAuth · 링크 기반 · 베타"}</p>
          <div className="inline-actions">
            <button className="text-button" type="button" onClick={() => void handle(() => onRefresh(transport))} disabled={busy}>다시 확인</button>
            {transport === "remote" ? <button className="text-button" type="button" onClick={() => void handle(onDisconnect)} disabled={busy}>연결 해제</button> : null}
          </div>
        </div>
      ) : transport === "desktop" ? (
        <div className="connection-instructions">
          <ol><li>Figma 데스크톱 앱에서 파일을 엽니다.</li><li>Dev Mode로 전환합니다.</li><li>MCP 서버를 켠 뒤 다시 확인합니다.</li></ol>
          <button className="secondary-button full" type="button" onClick={() => void handle(() => onRefresh("desktop"))} disabled={busy}>Desktop MCP 다시 확인</button>
          {status.message ? <p className="connection-detail">{status.message}</p> : null}
        </div>
      ) : (
        <div className="connection-instructions">
          <p>Remote는 링크 기반 Tool 범위가 넓지만 Figma의 승인 클라이언트 정책에 따라 이 독립 클라이언트의 연결이 제한될 수 있습니다.</p>
          <button className="primary-button full figma-primary" type="button" onClick={() => void handle(onOAuth)} disabled={busy}>Figma Remote 연결</button>
          {status.message ? <p className="connection-detail">{status.message}</p> : null}
        </div>
      )}
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
    </section>
  );
}
