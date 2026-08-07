import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TOKEN_PATH =
  process.env.FIGMA_TOKEN_STORE ?? path.join(HERE, '..', '.figma-token.json')

const API = 'https://api.figma.com'

/**
 * Personal Access Token 보관. 평문이므로 .gitignore 대상이다.
 * 환경변수 FIGMA_TOKEN이 있으면 그쪽이 우선한다.
 */
export function getToken() {
  if (process.env.FIGMA_TOKEN) return process.env.FIGMA_TOKEN
  if (!existsSync(TOKEN_PATH)) return null
  try {
    return JSON.parse(readFileSync(TOKEN_PATH, 'utf8')).token ?? null
  } catch {
    return null
  }
}

export function saveToken(token) {
  writeFileSync(TOKEN_PATH, JSON.stringify({ token }, null, 2), { mode: 0o600 })
}

export function clearToken() {
  if (existsSync(TOKEN_PATH)) writeFileSync(TOKEN_PATH, JSON.stringify({}), { mode: 0o600 })
}

class FigmaApiError extends Error {
  constructor(status, body, url) {
    super(`Figma API ${status}: ${body}`)
    this.status = status
    this.url = url
  }
}

async function call(pathname, token) {
  const url = `${API}${pathname}`
  const res = await fetch(url, { headers: { 'X-Figma-Token': token } })
  const text = await res.text()
  if (!res.ok) throw new FigmaApiError(res.status, text.slice(0, 400), url)
  return JSON.parse(text)
}

/** 토큰 유효성 확인 겸 계정 정보. */
export async function whoami(token) {
  return call('/v1/me', token)
}

/**
 * 파일 종류/노드 유무에 따라 호출할 REST 엔드포인트 계획을 세운다.
 * MCP 툴 계획(buildToolPlan)과 같은 역할을 REST 쪽에서 한다.
 */
export function buildRestPlan({ fileKey, nodeId }) {
  const plan = []
  const ids = nodeId ? encodeURIComponent(nodeId) : null

  if (ids) {
    // 지정 노드의 서브트리 전체. geometry=paths로 벡터 좌표까지 포함시킨다.
    plan.push({
      name: 'nodes',
      label: `GET /v1/files/${fileKey}/nodes?ids=${nodeId}`,
      path: `/v1/files/${fileKey}/nodes?ids=${ids}&geometry=paths`,
    })
    plan.push({
      name: 'images',
      label: `GET /v1/images/${fileKey}?ids=${nodeId}`,
      path: `/v1/images/${fileKey}?ids=${ids}&format=png&scale=2`,
    })
  } else {
    // 노드 미지정이면 문서 전체. depth 제한 없이 받으면 매우 커질 수 있다.
    plan.push({
      name: 'file',
      label: `GET /v1/files/${fileKey}`,
      path: `/v1/files/${fileKey}?geometry=paths`,
    })
  }

  plan.push({
    name: 'components',
    label: `GET /v1/files/${fileKey}/components`,
    path: `/v1/files/${fileKey}/components`,
  })
  plan.push({
    name: 'styles',
    label: `GET /v1/files/${fileKey}/styles`,
    path: `/v1/files/${fileKey}/styles`,
  })
  plan.push({
    name: 'variables',
    label: `GET /v1/files/${fileKey}/variables/local`,
    path: `/v1/files/${fileKey}/variables/local`,
    // Enterprise 플랜 전용이라 403이 정상 응답일 수 있다.
    optional: true,
    note: 'Enterprise 플랜에서만 접근 가능합니다.',
  })

  return plan
}

/** 계획대로 순차 호출하고, 각 응답을 가공 없이 담아 돌려준다. */
export async function runRestPlan(target, token) {
  const results = []
  for (const step of buildRestPlan(target)) {
    const t0 = Date.now()
    try {
      const raw = await call(step.path, token)
      results.push({
        tool: step.name,
        args: { path: step.path },
        status: 'ok',
        durationMs: Date.now() - t0,
        text: step.label,
        raw,
      })
    } catch (err) {
      results.push({
        tool: step.name,
        args: { path: step.path },
        status: step.optional ? 'unavailable' : 'failed',
        durationMs: Date.now() - t0,
        error: step.note ? `${err.message} (${step.note})` : err.message,
      })
    }
  }
  return results
}
