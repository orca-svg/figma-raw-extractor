export type ToolStatus = 'ok' | 'tool_error' | 'failed' | 'unavailable'

export interface ToolResult {
  tool: string
  args: Record<string, unknown>
  status: ToolStatus
  durationMs?: number
  text?: string
  raw?: unknown
  error?: string
}

export interface ExtractTarget {
  kind: 'design' | 'board' | 'slides' | 'make'
  fileKey: string
  nodeId: string | null
  rawNodeId: string | null
  href: string
}

export type Source = 'rest' | 'mcp'

export interface TokenStatus {
  present: boolean
  valid?: boolean
  email?: string
  handle?: string
  error?: string
}

export interface AuthStatus {
  endpoint: string
  required: boolean
  authenticated: boolean
  redirectUrl: string
}

export interface ExtractResponse {
  target: ExtractTarget
  source: Source
  endpoint: string
  toolsAvailable: string[]
  skipped: { tool: string; reason: string }[]
  results: ToolResult[]
  totalMs: number
}
