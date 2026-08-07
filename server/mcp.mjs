import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { FileOAuthProvider } from './oauth.mjs'

export const DEFAULT_ENDPOINT =
  process.env.FIGMA_MCP_URL ?? 'https://mcp.figma.com/mcp'

export const PROXY_ORIGIN =
  process.env.PROXY_ORIGIN ?? `http://127.0.0.1:${process.env.PORT ?? 5174}`

export const REDIRECT_URL = `${PROXY_ORIGIN}/oauth/callback`

/** 인증이 필요해 연결이 중단됐음을 알리는 에러. 인가 URL을 함께 들고 간다. */
export class AuthRequiredError extends Error {
  constructor(authorizationUrl, endpoint) {
    super('Figma 인증이 필요합니다.')
    this.name = 'AuthRequiredError'
    this.authorizationUrl = authorizationUrl
    this.endpoint = endpoint
  }
}

/** 루프백 주소는 Figma 데스크톱의 로컬 서버라 인증이 필요 없다. */
export function needsAuth(endpoint) {
  const { hostname } = new URL(endpoint)
  return !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname)
}

export function makeAuthProvider(endpoint) {
  return new FileOAuthProvider(endpoint, REDIRECT_URL)
}

export function makeTransport(endpoint, authProvider) {
  return new StreamableHTTPClientTransport(new URL(endpoint), { authProvider })
}

/**
 * Figma MCP 서버에 붙어 콜백을 실행하고 반드시 연결을 닫는다.
 * 원격 엔드포인트에는 OAuth 프로바이더를 붙이고, 인증이 없으면 AuthRequiredError를 던진다.
 */
export async function withMcpClient(endpointInput, fn) {
  const endpoint = endpointInput || DEFAULT_ENDPOINT
  const target = new URL(endpoint)
  const authProvider = needsAuth(endpoint) ? makeAuthProvider(endpoint) : undefined

  const client = new Client(
    { name: 'figma-raw-extractor', version: '0.1.0' },
    { capabilities: {} },
  )

  let connected = false
  let firstError
  const attempts = [
    () => new StreamableHTTPClientTransport(target, { authProvider }),
    // 구형 서버 폴백. 인증 실패일 때는 시도하지 않는다.
    () => new SSEClientTransport(target, { authProvider }),
  ]

  for (const makeIt of attempts) {
    try {
      await client.connect(makeIt())
      connected = true
      break
    } catch (err) {
      // SDK가 redirectToAuthorization을 호출했다면 인가 URL이 채워져 있다.
      if (err instanceof UnauthorizedError || authProvider?.authorizationUrl) {
        await client.close().catch(() => {})
        throw new AuthRequiredError(authProvider?.authorizationUrl ?? null, endpoint)
      }
      firstError ??= err
    }
  }

  if (!connected) {
    await client.close().catch(() => {})
    throw new Error(
      `MCP 서버에 연결하지 못했습니다 (${target.href}). ` +
        (needsAuth(endpoint)
          ? '네트워크 또는 서버 상태를 확인하세요.'
          : 'Figma 데스크톱 앱이 실행 중이고 Preferences > Enable local MCP server 가 켜져 있는지 확인하세요.') +
        ` 원인: ${firstError?.message ?? '알 수 없음'}`,
    )
  }

  try {
    return await fn(client)
  } finally {
    await client.close().catch(() => {})
  }
}

/**
 * 파싱된 Figma URL을 기준으로 호출할 툴 목록과 인자를 구성한다.
 * 툴별 지원 파일 종류/필수 인자는 Figma MCP 스펙을 따른다.
 */
export function buildToolPlan({ kind, fileKey, nodeId }) {
  const plan = []

  if (kind === 'design') {
    // nodeId 생략 시 최상위 페이지 목록을 돌려주므로 항상 호출 가능하다.
    plan.push({
      name: 'get_metadata',
      args: nodeId ? { fileKey, nodeId } : { fileKey },
    })
  }

  // Figma Make 파일은 nodeId가 항상 0:1로 고정된다.
  const contextNodeId = kind === 'make' ? '0:1' : nodeId
  if (contextNodeId) {
    plan.push({
      name: 'get_design_context',
      args: {
        fileKey,
        nodeId: contextNodeId,
        clientLanguages: 'typescript,javascript,css',
        clientFrameworks: 'react',
        // 스크린샷은 get_screenshot으로 따로 받으므로 중복 제거
        excludeScreenshot: true,
        forceCode: true,
      },
    })
  }

  if (kind === 'design' && nodeId) {
    plan.push({ name: 'get_variable_defs', args: { fileKey, nodeId } })
  }

  if (kind !== 'make' && nodeId) {
    plan.push({
      name: 'get_screenshot',
      args: { fileKey, nodeId, maxDimension: 2048 },
    })
  }

  return plan
}

/** MCP 툴 결과에서 텍스트 콘텐츠만 이어붙인다. raw 원본은 별도로 보존한다. */
export function flattenText(result) {
  const parts = Array.isArray(result?.content) ? result.content : []
  return parts
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
}
