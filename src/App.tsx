import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AuthStatus,
  ExtractResponse,
  Source,
  TokenStatus,
  ToolResult,
  ToolStatus,
} from './types'

const DEFAULT_ENDPOINT = 'http://127.0.0.1:3845/mcp'

const STATUS_LABEL: Record<ToolStatus, string> = {
  ok: 'OK',
  tool_error: 'TOOL ERROR',
  failed: 'FAILED',
  unavailable: 'N/A',
}

export default function App() {
  const [url, setUrl] = useState('')
  const [endpoint, setEndpoint] = useState(DEFAULT_ENDPOINT)
  const [showEndpoint, setShowEndpoint] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<ExtractResponse | null>(null)
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const [authPending, setAuthPending] = useState(false)
  const [source, setSource] = useState<Source>('rest')
  const [token, setToken] = useState<TokenStatus | null>(null)
  const [tokenInput, setTokenInput] = useState('')
  const [needsToken, setNeedsToken] = useState(false)

  const refreshToken = useCallback(async () => {
    const res = await fetch('/api/token/status')
    if (!res.ok) return null
    const status = (await res.json()) as TokenStatus
    setToken(status)
    return status
  }, [])

  useEffect(() => {
    void refreshToken()
  }, [refreshToken])

  const refreshAuth = useCallback(async () => {
    const res = await fetch(`/api/auth/status?endpoint=${encodeURIComponent(endpoint)}`)
    if (!res.ok) return null
    const status = (await res.json()) as AuthStatus
    setAuth(status)
    return status
  }, [endpoint])

  useEffect(() => {
    void refreshAuth()
  }, [refreshAuth])

  const extract = useCallback(async () => {
    setLoading(true)
    setError(null)
    setData(null)
    setAuthUrl(null)
    setNeedsToken(false)
    try {
      const res = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, endpoint, source }),
      })
      const json = await res.json()
      if (res.status === 401 && json.needsToken) {
        setNeedsToken(true)
        setError(json.error)
        return
      }
      if (res.status === 401 && json.needsAuth) {
        setAuthUrl(json.authorizationUrl ?? null)
        setError(json.error)
        void refreshAuth()
        return
      }
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      setData(json as ExtractResponse)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [url, endpoint, source, refreshAuth])

  const submitToken = useCallback(async () => {
    setError(null)
    const res = await fetch('/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: tokenInput }),
    })
    const json = await res.json()
    if (!res.ok) return setError(json.error)
    setTokenInput('')
    setNeedsToken(false)
    await refreshToken()
    if (url.trim()) await extract()
  }, [tokenInput, refreshToken, url, extract])

  /** 새 창에서 Figma 인가를 마칠 때까지 상태를 폴링하고, 끝나면 자동으로 재시도한다. */
  const signIn = useCallback(async () => {
    if (!authUrl) return
    window.open(authUrl, 'figma-oauth', 'width=520,height=720')
    setAuthPending(true)
    try {
      for (let i = 0; i < 150; i++) {
        await new Promise((r) => setTimeout(r, 2000))
        const status = await refreshAuth()
        if (status?.authenticated) {
          setAuthUrl(null)
          setError(null)
          await extract()
          return
        }
      }
      setError('인증 대기 시간이 초과되었습니다. 다시 시도하세요.')
    } finally {
      setAuthPending(false)
    }
  }, [authUrl, refreshAuth, extract])

  const resetAuth = useCallback(async () => {
    await fetch('/api/auth/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    })
    setAuthUrl(null)
    setData(null)
    setError(null)
    void refreshAuth()
  }, [endpoint, refreshAuth])

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (url.trim() && !loading) void extract()
  }

  const filename = useMemo(() => {
    if (!data) return 'figma-raw.json'
    const node = data.target.nodeId?.replace(':', '-') ?? 'file'
    return `figma-${data.target.fileKey}-${node}.json`
  }, [data])

  return (
    <div className="app">
      <header className="head">
        <h1>Figma Raw Data Extractor</h1>
        <p className="sub">
          Figma URL을 넣으면 로컬 Figma MCP 서버의 모든 툴을 호출해 원본 응답을
          그대로 덤프합니다.
        </p>
      </header>

      <form className="bar" onSubmit={onSubmit}>
        <input
          className="url"
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.figma.com/design/:fileKey/:name?node-id=1-2"
          spellCheck={false}
          autoFocus
        />
        <button type="submit" disabled={loading || !url.trim()}>
          {loading ? '추출 중…' : '추출'}
        </button>
      </form>

      <div className="endpoint-row">
        <div className="seg">
          <button
            type="button"
            className={source === 'rest' ? 'on' : ''}
            onClick={() => setSource('rest')}
          >
            REST API (원격)
          </button>
          <button
            type="button"
            className={source === 'mcp' ? 'on' : ''}
            onClick={() => setSource('mcp')}
          >
            MCP (로컬)
          </button>
        </div>

        {source === 'rest' ? (
          <>
            <span className={`dot ${token?.valid ? 'on' : 'off'}`}>
              {token?.valid ? `토큰 유효 · ${token.handle ?? ''}` : '토큰 필요'}
            </span>
            {token?.present && (
              <button
                type="button"
                className="link"
                onClick={async () => {
                  await fetch('/api/token/reset', { method: 'POST' })
                  setData(null)
                  void refreshToken()
                }}
              >
                토큰 삭제
              </button>
            )}
          </>
        ) : (
          <>
            {auth && (
              <span className={`dot ${auth.authenticated ? 'on' : 'off'}`}>
                {auth.required
                  ? auth.authenticated
                    ? '인증됨'
                    : '미인증'
                  : '로컬 (인증 불필요)'}
              </span>
            )}
            <button
              type="button"
              className="link"
              onClick={() => setShowEndpoint((v) => !v)}
            >
              엔드포인트 {showEndpoint ? '숨기기' : '설정'}
            </button>
            {auth?.authenticated && auth.required && (
              <button type="button" className="link" onClick={resetAuth}>
                인증 초기화
              </button>
            )}
            {showEndpoint && (
              <input
                className="endpoint"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                spellCheck={false}
              />
            )}
          </>
        )}
      </div>

      {(needsToken || (source === 'rest' && token && !token.valid)) && (
        <div className="panel auth">
          <strong>Figma Personal Access Token이 필요합니다</strong>
          <p className="dim">
            Figma → Settings → Security → Personal access tokens → Generate new
            token. <code>File content: Read-only</code> 권한이면 충분합니다.
            토큰은 이 컴퓨터의 <code>.figma-token.json</code> 에만 저장되며 브라우저로
            돌아가지 않습니다.
          </p>
          <div className="bar">
            <input
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="figd_..."
              spellCheck={false}
            />
            <button
              type="button"
              className="primary"
              onClick={submitToken}
              disabled={!tokenInput.trim()}
            >
              저장
            </button>
          </div>
        </div>
      )}

      {authUrl && (
        <div className="panel auth">
          <strong>Figma 인증이 필요합니다</strong>
          <p className="dim">
            새 창에서 Figma에 로그인하고 접근을 허용하면 자동으로 추출을 이어갑니다.
          </p>
          <button type="button" className="primary" onClick={signIn} disabled={authPending}>
            {authPending ? '인증 대기 중…' : 'Figma로 로그인'}
          </button>
        </div>
      )}

      {error && !authUrl && (
        <div className="panel err">
          <strong>실패</strong>
          <pre>{error}</pre>
        </div>
      )}

      {data && (
        <>
          <section className="panel summary">
            <div className="meta">
              <Meta k="kind" v={data.target.kind} />
              <Meta k="fileKey" v={data.target.fileKey} />
              <Meta k="nodeId" v={data.target.nodeId ?? '(없음)'} />
              <Meta k="source" v={data.source} />
              <Meta k="endpoint" v={data.endpoint} />
              <Meta k="총 소요" v={`${data.totalMs}ms`} />
            </div>
            <div className="actions">
              <CopyButton
                label="전체 JSON 복사"
                text={() => JSON.stringify(data, null, 2)}
              />
              <button
                type="button"
                onClick={() => download(filename, JSON.stringify(data, null, 2))}
              >
                다운로드
              </button>
            </div>
          </section>

          {data.skipped.length > 0 && (
            <section className="panel warn">
              <strong>건너뛴 툴</strong>
              <ul>
                {data.skipped.map((s, i) => (
                  <li key={i}>
                    <code>{s.tool}</code> — {s.reason}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {data.results.map((r) => (
            <ToolCard key={r.tool} result={r} />
          ))}
        </>
      )}
    </div>
  )
}

function Meta({ k, v }: { k: string; v: string }) {
  return (
    <div className="meta-item">
      <span className="meta-k">{k}</span>
      <span className="meta-v">{v}</span>
    </div>
  )
}

function ToolCard({ result }: { result: ToolResult }) {
  const [tab, setTab] = useState<'text' | 'raw'>('text')
  const [open, setOpen] = useState(result.status === 'ok')

  const rawJson = useMemo(
    () => JSON.stringify(result.raw ?? result, null, 2),
    [result],
  )
  const body = tab === 'text' ? (result.text ?? result.error ?? '') : rawJson

  return (
    <section className={`panel tool status-${result.status}`}>
      <header className="tool-head">
        <button
          type="button"
          className="disclosure"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? '▾' : '▸'} <code>{result.tool}</code>
        </button>
        <span className={`badge ${result.status}`}>
          {STATUS_LABEL[result.status]}
        </span>
        {result.durationMs != null && (
          <span className="dim">{result.durationMs}ms</span>
        )}
        <span className="spacer" />
        <CopyButton label="복사" text={() => body} />
      </header>

      {open && (
        <>
          <div className="tabs">
            <button
              type="button"
              className={tab === 'text' ? 'on' : ''}
              onClick={() => setTab('text')}
            >
              text
            </button>
            <button
              type="button"
              className={tab === 'raw' ? 'on' : ''}
              onClick={() => setTab('raw')}
            >
              raw JSON
            </button>
            <span className="dim args">{JSON.stringify(result.args)}</span>
          </div>
          <pre className="out">{body || '(빈 응답)'}</pre>
        </>
      )}
    </section>
  )
}

function CopyButton({ label, text }: { label: string; text: () => string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text())
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
    >
      {done ? '복사됨' : label}
    </button>
  )
}

function download(name: string, content: string) {
  const blob = new Blob([content], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  URL.revokeObjectURL(a.href)
}
