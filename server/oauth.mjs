import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STORE_PATH =
  process.env.FIGMA_MCP_AUTH_STORE ??
  path.join(HERE, '..', '.figma-mcp-auth.json')

/**
 * 엔드포인트별 OAuth 상태를 JSON 파일에 보관한다.
 * 액세스 토큰이 평문으로 저장되므로 반드시 .gitignore에 포함되어야 한다.
 */
function readStore() {
  if (!existsSync(STORE_PATH)) return {}
  try {
    return JSON.parse(readFileSync(STORE_PATH, 'utf8'))
  } catch {
    return {}
  }
}

function writeStore(store) {
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), { mode: 0o600 })
}

/** 같은 엔드포인트는 항상 같은 키를 쓰도록 정규화한다. */
export function storeKey(endpoint) {
  const u = new URL(endpoint)
  return `${u.origin}${u.pathname}`.replace(/\/$/, '')
}

export function hasTokens(endpoint) {
  return Boolean(readStore()[storeKey(endpoint)]?.tokens?.access_token)
}

export function clearAuth(endpoint) {
  const store = readStore()
  delete store[storeKey(endpoint)]
  writeStore(store)
}

/** MCP SDK가 요구하는 OAuthClientProvider 구현. */
export class FileOAuthProvider {
  /**
   * @param {string} endpoint MCP 서버 URL
   * @param {string} redirectUrl OAuth 콜백 URL (프록시가 서빙)
   */
  constructor(endpoint, redirectUrl) {
    this.key = storeKey(endpoint)
    this._redirectUrl = redirectUrl
    /** redirectToAuthorization이 채워준다. 브라우저를 열 주체는 프론트엔드다. */
    this.authorizationUrl = null
  }

  #read() {
    return readStore()[this.key] ?? {}
  }

  #merge(patch) {
    const store = readStore()
    store[this.key] = { ...(store[this.key] ?? {}), ...patch }
    writeStore(store)
  }

  get redirectUrl() {
    return this._redirectUrl
  }

  get clientMetadata() {
    return {
      client_name: 'Figma Raw Data Extractor',
      redirect_uris: [this._redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
      scope: 'mcp:connect',
    }
  }

  /** Figma 인증 서버는 require_state_parameter=true 이므로 반드시 구현해야 한다. */
  state() {
    const state = randomUUID()
    this.#merge({ state })
    return state
  }

  /** 콜백에서 넘어온 state가 우리가 발급한 것인지 확인한다 (CSRF 방어). */
  verifyState(state) {
    return Boolean(state) && this.#read().state === state
  }

  clientInformation() {
    return this.#read().clientInformation
  }

  saveClientInformation(clientInformation) {
    this.#merge({ clientInformation })
  }

  tokens() {
    return this.#read().tokens
  }

  saveTokens(tokens) {
    // 인증이 끝났으므로 1회용 값은 정리한다.
    this.#merge({ tokens, codeVerifier: undefined, state: undefined })
  }

  redirectToAuthorization(authorizationUrl) {
    // 서버에는 브라우저가 없다. URL만 보관하고 프론트엔드가 열도록 넘긴다.
    this.authorizationUrl = authorizationUrl.toString()
  }

  saveCodeVerifier(codeVerifier) {
    this.#merge({ codeVerifier })
  }

  codeVerifier() {
    const v = this.#read().codeVerifier
    if (!v) throw new Error('code verifier가 없습니다. 인증을 다시 시작하세요.')
    return v
  }

  invalidateCredentials(scope) {
    if (scope === 'all') return clearAuth(this.key)
    const patch = {}
    if (scope === 'client') patch.clientInformation = undefined
    if (scope === 'tokens') patch.tokens = undefined
    if (scope === 'verifier') patch.codeVerifier = undefined
    this.#merge(patch)
  }
}
