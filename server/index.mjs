import express from 'express'
import cors from 'cors'
import { parseFigmaUrl, FigmaUrlError } from './figma-url.mjs'
import {
  DEFAULT_ENDPOINT,
  REDIRECT_URL,
  AuthRequiredError,
  withMcpClient,
  buildToolPlan,
  flattenText,
  needsAuth,
  makeAuthProvider,
  makeTransport,
} from './mcp.mjs'
import { hasTokens, clearAuth } from './oauth.mjs'
import {
  getToken,
  saveToken,
  clearToken,
  whoami,
  runRestPlan,
} from './rest.mjs'

const PORT = Number(process.env.PORT ?? 5174)

const app = express()
app.use(cors())
app.use(express.json({ limit: '4mb' }))

/** 인증 필요를 401 + 인가 URL로 변환한다. 프론트엔드가 이 URL을 연다. */
function sendError(res, err) {
  if (err instanceof AuthRequiredError) {
    return res.status(401).json({
      needsAuth: true,
      authorizationUrl: err.authorizationUrl,
      endpoint: err.endpoint,
      error: 'Figma 인증이 필요합니다. 로그인 후 다시 시도하세요.',
    })
  }
  return res.status(502).json({ error: err.message })
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, defaultEndpoint: DEFAULT_ENDPOINT })
})

/** 현재 엔드포인트의 인증 상태. */
app.get('/api/auth/status', (req, res) => {
  const endpoint = req.query.endpoint || DEFAULT_ENDPOINT
  try {
    const required = needsAuth(endpoint)
    res.json({
      endpoint,
      required,
      authenticated: required ? hasTokens(endpoint) : true,
      redirectUrl: REDIRECT_URL,
    })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

/** 저장된 토큰/클라이언트 등록 정보를 지운다. */
app.post('/api/auth/reset', (req, res) => {
  const endpoint = req.body?.endpoint || DEFAULT_ENDPOINT
  clearAuth(endpoint)
  res.json({ ok: true, endpoint })
})

/**
 * OAuth 콜백. Figma가 브라우저를 여기로 되돌려 보낸다.
 * 디스크에 보관된 code verifier / 클라이언트 등록 정보로 토큰 교환을 마친다.
 */
app.get('/oauth/callback', async (req, res) => {
  const { code, state, error, error_description: desc } = req.query
  const endpoint = DEFAULT_ENDPOINT

  if (error) return res.status(400).send(page('인증 거부됨', `${error}: ${desc ?? ''}`))
  if (!code) return res.status(400).send(page('실패', 'authorization code가 없습니다.'))

  const provider = makeAuthProvider(endpoint)
  if (!provider.verifyState(state)) {
    return res.status(400).send(page('실패', 'state 불일치 — 요청을 폐기했습니다.'))
  }

  const transport = makeTransport(endpoint, provider)
  try {
    await transport.finishAuth(String(code))
    res.send(page('인증 완료', '이 창은 닫아도 됩니다. 앱으로 돌아가세요.'))
  } catch (err) {
    res.status(502).send(page('토큰 교환 실패', err.message))
  } finally {
    await transport.close().catch(() => {})
  }
})

/** 연결된 MCP 서버가 노출하는 툴 목록 (스키마 포함, 원본 그대로). */
app.post('/api/tools', async (req, res) => {
  try {
    res.json(await withMcpClient(req.body?.endpoint, (c) => c.listTools()))
  } catch (err) {
    sendError(res, err)
  }
})

/** 임의 툴 직접 호출 — 계획된 4종 외의 데이터를 뽑고 싶을 때. */
app.post('/api/call', async (req, res) => {
  const { endpoint, name, args } = req.body ?? {}
  if (!name) return res.status(400).json({ error: 'name이 필요합니다.' })
  try {
    const result = await withMcpClient(endpoint, (c) =>
      c.callTool({ name, arguments: args ?? {} }),
    )
    res.json({ name, result, text: flattenText(result) })
  } catch (err) {
    sendError(res, err)
  }
})

/** REST 소스용 Personal Access Token 상태. */
app.get('/api/token/status', async (_req, res) => {
  const token = getToken()
  if (!token) return res.json({ present: false })
  try {
    const me = await whoami(token)
    res.json({ present: true, valid: true, email: me.email, handle: me.handle })
  } catch (err) {
    res.json({ present: true, valid: false, error: err.message })
  }
})

app.post('/api/token', async (req, res) => {
  const token = String(req.body?.token ?? '').trim()
  if (!token) return res.status(400).json({ error: '토큰이 비어 있습니다.' })
  try {
    // 저장 전에 실제로 통하는 토큰인지 확인한다.
    const me = await whoami(token)
    saveToken(token)
    res.json({ ok: true, email: me.email, handle: me.handle })
  } catch (err) {
    res.status(401).json({ error: `토큰이 유효하지 않습니다. ${err.message}` })
  }
})

app.post('/api/token/reset', (_req, res) => {
  clearToken()
  res.json({ ok: true })
})

/** 메인 엔드포인트: Figma URL -> 전 툴 덤프. */
app.post('/api/extract', async (req, res) => {
  const { url, endpoint, source = 'rest' } = req.body ?? {}

  let target
  try {
    target = parseFigmaUrl(url)
  } catch (err) {
    const status = err instanceof FigmaUrlError ? 400 : 500
    return res.status(status).json({ error: err.message })
  }

  const startedAt = Date.now()

  if (source === 'rest') {
    const token = getToken()
    if (!token) {
      return res.status(401).json({
        needsToken: true,
        error:
          'Figma Personal Access Token이 필요합니다. Figma > Settings > Security > Personal access tokens 에서 발급하세요.',
      })
    }
    try {
      const results = await runRestPlan(target, token)
      return res.json({
        target,
        source: 'rest',
        endpoint: 'https://api.figma.com',
        toolsAvailable: results.map((r) => r.tool),
        skipped: restSkipReasons(target),
        results,
        totalMs: Date.now() - startedAt,
      })
    } catch (err) {
      return res.status(502).json({ error: err.message })
    }
  }

  try {
    const payload = await withMcpClient(endpoint, async (client) => {
      const { tools } = await client.listTools()
      const available = new Set(tools.map((t) => t.name))

      const plan = buildToolPlan(target)
      const results = []

      // MCP 서버는 단일 세션이라 순차 호출이 안전하다.
      for (const step of plan) {
        if (!available.has(step.name)) {
          results.push({
            tool: step.name,
            args: step.args,
            status: 'unavailable',
            error: '이 MCP 서버에 존재하지 않는 툴입니다.',
          })
          continue
        }

        const t0 = Date.now()
        try {
          const result = await client.callTool({
            name: step.name,
            arguments: step.args,
          })
          results.push({
            tool: step.name,
            args: step.args,
            status: result.isError ? 'tool_error' : 'ok',
            durationMs: Date.now() - t0,
            text: flattenText(result),
            raw: result,
          })
        } catch (err) {
          results.push({
            tool: step.name,
            args: step.args,
            status: 'failed',
            durationMs: Date.now() - t0,
            error: err.message,
          })
        }
      }

      return {
        target,
        source: 'mcp',
        endpoint: endpoint || DEFAULT_ENDPOINT,
        toolsAvailable: tools.map((t) => t.name),
        skipped: skipReasons(target),
        results,
      }
    })

    res.json({ ...payload, totalMs: Date.now() - startedAt })
  } catch (err) {
    sendError(res, err)
  }
})

/** REST 소스에서 못 가져오는 것들을 명시한다. */
function restSkipReasons({ nodeId }) {
  const out = []
  if (!nodeId) {
    out.push({
      tool: 'GET /v1/files/:key/nodes, /v1/images/:key',
      reason:
        'URL에 node-id가 없어 문서 전체(/v1/files/:key)를 받았습니다. 특정 노드만 받으려면 "Copy link to selection" URL을 넣으세요.',
    })
  }
  out.push({
    tool: 'get_design_context 상당 기능',
    reason:
      'REST API는 코드 생성용 컨텍스트를 제공하지 않습니다. 원본 문서 JSON에서 직접 파생시켜야 합니다.',
  })
  return out
}

/** 호출하지 않은 툴과 그 이유 — 조용한 누락을 만들지 않기 위해 명시한다. */
function skipReasons({ kind, nodeId }) {
  const out = []
  if (kind !== 'design') {
    out.push({
      tool: 'get_metadata / get_variable_defs',
      reason: `${kind} 파일은 design 파일 전용 툴을 지원하지 않습니다.`,
    })
  }
  if (!nodeId) {
    out.push({
      tool: 'get_design_context / get_variable_defs / get_screenshot',
      reason:
        'URL에 node-id가 없습니다. Figma에서 레이어를 선택한 뒤 "Copy link to selection"으로 얻은 URL을 넣으면 전부 추출됩니다.',
    })
  }
  if (kind === 'make') {
    out.push({
      tool: 'get_screenshot',
      reason: 'Figma Make 파일은 스크린샷 툴을 지원하지 않습니다.',
    })
  }
  return out
}

function page(title, body) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:15px/1.6 ui-sans-serif,system-ui;background:#0e0f12;color:#e6e8ec;
display:grid;place-items:center;height:100vh;margin:0;text-align:center">
<div><h1 style="font-size:20px;margin:0 0 8px">${title}</h1>
<p style="color:#8b929e;margin:0;max-width:40ch">${body}</p></div>`
}

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[server] http://127.0.0.1:${PORT}  -> MCP ${DEFAULT_ENDPOINT}`)
  console.log(`[server] OAuth callback: ${REDIRECT_URL}`)
})
