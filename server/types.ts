import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type Provider = "notion" | "figma";
export type TraceOrigin = "mcp" | "internal";

export type ToolDescriptor = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

export interface McpAdapter {
  listTools(): Promise<ToolDescriptor[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

export type NotionExtractionInput = {
  target: string;
  expectedEmail?: string;
  searchQuery?: string;
  maxRows: number;
  includeArchived: boolean;
  includeComments: boolean;
  includeTranscript: boolean;
  mode?: "live" | "demo";
};

/** Kept as an alias for the existing Notion pipeline and its tests. */
export type ExtractionInput = NotionExtractionInput;

export type FigmaTransport = "desktop" | "remote";
export type FigmaFileType = "design" | "figjam";
export type FigmaTargetMode = "link" | "selection";

export type FigmaExtractionInput = {
  target: string;
  targetMode: FigmaTargetMode;
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

export type FigmaTarget = {
  fileKey: string;
  nodeId: string;
  fileType: FigmaFileType;
  sourceUrl: string;
};

export type StepState = "running" | "success" | "warning" | "error" | "skipped";

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
  origin?: TraceOrigin;
  responseBytes?: number;
  artifacts?: ArtifactRef[];
};

export type EmitEvent = (event: ExtractionEvent) => void | Promise<void>;

export type ParsedToolResult = {
  isError: boolean;
  text: string;
  payload: unknown;
  raw: CallToolResult;
};

export type ArtifactRef = {
  id: string;
  path: string;
  mimeType: string;
  bytes: number;
  kind: "screenshot" | "asset" | "binary";
};

export type StoredArtifact = ArtifactRef & {
  data: Uint8Array;
};

export type FigmaRunRecord = {
  id: string;
  sessionId: string;
  startedAt: string;
  completedAt?: string;
  expiresAt: number;
  input: FigmaExtractionInput;
  detectedFileType?: FigmaFileType;
  tools: ToolDescriptor[];
  events: ExtractionEvent[];
  artifacts: Map<string, StoredArtifact>;
  artifactBytes: number;
};
