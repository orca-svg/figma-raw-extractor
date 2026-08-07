/**
 * Figma URL을 fileKey / nodeId / 파일 종류로 분해한다.
 *
 * 지원 형태:
 *   https://figma.com/design/:fileKey/:fileName?node-id=1-2
 *   https://figma.com/design/:fileKey/branch/:branchKey/:fileName   -> branchKey를 fileKey로 사용
 *   https://figma.com/board/:fileKey/...    (FigJam)
 *   https://figma.com/slides/:fileKey/...
 *   https://figma.com/make/:fileKey/...
 */

const FILE_KEY_RE = /^[0-9a-zA-Z]{22,128}$/
const KIND_SEGMENTS = new Set(['design', 'board', 'slides', 'make', 'file', 'proto'])

export class FigmaUrlError extends Error {}

export function parseFigmaUrl(input) {
  const raw = String(input ?? '').trim()
  if (!raw) throw new FigmaUrlError('URL이 비어 있습니다.')

  let url
  try {
    url = new URL(raw)
  } catch {
    throw new FigmaUrlError(`URL 형식이 올바르지 않습니다: ${raw}`)
  }

  if (!/(^|\.)figma\.com$/i.test(url.hostname)) {
    throw new FigmaUrlError(`figma.com 주소가 아닙니다: ${url.hostname}`)
  }

  const segments = url.pathname.split('/').filter(Boolean)
  const kindIndex = segments.findIndex((s) => KIND_SEGMENTS.has(s))
  if (kindIndex === -1) {
    throw new FigmaUrlError(
      'URL에서 /design/, /board/, /slides/, /make/ 경로를 찾지 못했습니다.',
    )
  }

  // /file/ 과 /proto/ 는 구형 링크 — design 파일과 동일하게 취급한다.
  const rawKind = segments[kindIndex]
  const kind = rawKind === 'file' || rawKind === 'proto' ? 'design' : rawKind

  let fileKey = segments[kindIndex + 1]
  // branch URL이면 branchKey가 실질적인 fileKey다.
  if (segments[kindIndex + 2] === 'branch' && segments[kindIndex + 3]) {
    fileKey = segments[kindIndex + 3]
  }

  if (!fileKey || !FILE_KEY_RE.test(fileKey)) {
    throw new FigmaUrlError(`fileKey를 추출하지 못했습니다: ${fileKey ?? '(없음)'}`)
  }

  const rawNodeId = url.searchParams.get('node-id')
  // Figma는 URL에 1-2 형태로, MCP는 1:2 형태를 기대한다.
  const nodeId = rawNodeId ? rawNodeId.replace(/-/g, ':') : null

  return { kind, fileKey, nodeId, rawNodeId, href: url.href }
}
