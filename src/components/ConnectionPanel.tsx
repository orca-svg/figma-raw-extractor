import { useState } from "react";
import type { ConnectionStatus } from "../types";

type Props = {
  status: ConnectionStatus;
  expectedEmail: string;
  onExpectedEmailChange: (value: string) => void;
  onOAuth: () => Promise<void>;
  onPat: (token: string) => Promise<void>;
  onDisconnect: () => Promise<void>;
  busy: boolean;
};

export function ConnectionPanel({ status, expectedEmail, onExpectedEmailChange, onOAuth, onPat, onDisconnect, busy }: Props) {
  const [pat, setPat] = useState("");
  const [error, setError] = useState<string>();

  const handle = async (action: () => Promise<void>) => {
    setError(undefined);
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const handlePatConnection = async () => {
    await handle(async () => {
      await onPat(pat);
      setPat("");
    });
  };

  return (
    <section className="panel connection-panel" aria-labelledby="connection-title">
      <div className="panel-heading">
        <span className="section-mark">01</span>
        <div>
          <p className="eyebrow">계정</p>
          <h2 id="connection-title">Notion 연결</h2>
        </div>
      </div>

      {status.connected ? (
        <div className="connected-card">
          <div className="connected-line">
            <span className="status-dot success" />
            <strong>{status.identity?.workspace?.name ?? "연결된 워크스페이스"}</strong>
          </div>
          <p>{status.identity?.user?.name} · {status.identity?.user?.email}</p>
          <p className="small-copy">{status.authKind === "oauth" ? "OAuth 연결" : "개인 토큰 연결"}</p>
          <button className="text-button" type="button" onClick={() => void handle(onDisconnect)} disabled={busy}>연결 해제</button>
        </div>
      ) : (
        <>
          <label className="field">
            <span>확인할 계정 이메일</span>
            <input
              type="email"
              value={expectedEmail}
              onChange={(event) => onExpectedEmailChange(event.target.value)}
              placeholder="name@company.com"
              autoComplete="email"
            />
            <small>OAuth 뒤 실제 연결 계정과 비교합니다.</small>
          </label>
          <button className="primary-button full" type="button" onClick={() => void handle(onOAuth)} disabled={busy}>
            Notion에서 계정 연결
          </button>
          <details className="pat-box">
            <summary>개인 토큰으로 연결</summary>
            <p>토큰은 서버 메모리에만 두며 파일이나 브라우저 저장소에 쓰지 않습니다.</p>
            <label className="field compact">
              <span>Personal access token</span>
              <input type="password" value={pat} onChange={(event) => setPat(event.target.value)} autoComplete="off" />
            </label>
            <button className="secondary-button full" type="button" onClick={() => void handlePatConnection()} disabled={!pat || busy}>토큰 확인 후 연결</button>
          </details>
        </>
      )}
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
    </section>
  );
}
