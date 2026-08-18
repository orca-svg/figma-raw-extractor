export type StepState = "running" | "success" | "warning" | "error" | "skipped";
export type Provider = "notion" | "figma";
export type AppView = "trace" | "tools";

export type ArtifactRef = {
  id: string;
  path: string;
  mimeType: string;
  bytes: number;
  kind: "screenshot" | "asset" | "binary";
};

export type ExtractionEvent = {
  type: "step" | "complete" | "fatal";
  id: string;
  order: number;
  group: string;
  label: string;
  state: StepState;
  tool?: string;
  startedAt: string;
  elapsedMs?: number;
  request?: unknown;
  response?: unknown;
  extracted?: unknown;
  message?: string;
  provider?: Provider;
  runId?: string;
  origin?: "mcp" | "internal" | "codex";
  responseBytes?: number;
  artifacts?: ArtifactRef[];
};

export type Identity = {
  workspace?: { id?: string; name?: string };
  user?: { id?: string; name?: string; email?: string; type?: string };
  current_tool_access?: Record<string, { status?: string; upgrade_url?: string }>;
};

export type ConnectionStatus = {
  connected: boolean;
  authKind?: "oauth" | "pat";
  identity?: Identity;
  expectedEmail?: string;
  message?: string;
};

export type ExtractionOptions = {
  target: string;
  expectedEmail?: string;
  searchQuery?: string;
  maxRows: number;
  includeArchived: boolean;
  includeComments: boolean;
  includeTranscript: boolean;
  mode: "live" | "demo";
};

export type ToolDescriptor = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

export type FigmaTransport = "desktop" | "remote" | "codex";

export type CodexAuthFlow = {
  kind: "codex" | "figma";
  state: "waiting" | "complete" | "error";
  authUrl?: string;
  userCode?: string;
  message?: string;
  startedAt: number;
};

export type FigmaConnectionStatus = {
  connected: boolean;
  transport: FigmaTransport;
  beta?: boolean;
  tools?: ToolDescriptor[];
  identity?: unknown;
  message?: string;
  codex?: { installed: boolean; version?: string; authenticated: boolean };
  figmaMcp?: { configured: boolean; enabled: boolean; authenticated: boolean; authStatus?: string; url?: string };
  authFlow?: CodexAuthFlow;
};

export type FigmaExtractionOptions = {
  target: string;
  targetMode: "link" | "selection";
  transport: FigmaTransport;
  includeVariables: boolean;
  includeCodeConnect: boolean;
  includeMotion: boolean;
  includeLibraries: boolean;
  includeAssets: boolean;
  clientFrameworks: string;
  clientLanguages: string;
  codeConnectLabel?: string;
  mode: "live" | "demo";
};

export type FigmaRunPayload = {
  manifest: Record<string, unknown>;
  events: ExtractionEvent[];
};
