import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ChildProcess } from "node:child_process";

export type Provider = "notion" | "figma";
export type TraceOrigin = "mcp" | "internal" | "codex" | "plugin" | "rest";

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

export type FigmaTransport = "desktop" | "remote" | "codex" | "plugin";
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
  question?: string;
  mode: "live" | "demo";
};

export type FigmaQuestionInput = Omit<FigmaExtractionInput, "mode" | "targetMode"> & {
  transport: "codex" | "plugin";
  targetMode: "link";
  question: string;
  mode: "live";
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

export type EvidenceRef = {
  kind: "node" | "version" | "artifact" | "tool";
  nodeId?: string;
  versionId?: string;
  artifactId?: string;
  tool?: string;
  detail?: string;
};

export type FigmaQuestionAnswer = {
  answer: string;
  evidence: EvidenceRef[];
  uncertainties: string[];
  model: string;
  promptVersion: string;
  generatedAt: string;
};

export type SemanticHint = {
  nodeId: string;
  role: string;
  confidence: "low" | "medium" | "high";
  evidence: string[];
  provenance: Array<{ source: "node_type" | "layer_name" | "text" | "annotation" | "hierarchy" | "component" | "variable" | "prototype"; value: string }>;
};

export type FigmaVersionSnapshot = {
  id: string;
  createdAt: string;
  label?: string;
  description?: string;
  user?: { id?: string; name?: string; handle?: string; imgUrl?: string };
  node?: unknown;
  current?: boolean;
  missing?: boolean;
};

export type FigmaNodeChange = {
  versionId: string;
  createdAt: string;
  actor?: FigmaVersionSnapshot["user"];
  attribution: "coarse_version_attribution";
  nodeId: string;
  path: string;
  category: "created" | "deleted" | "moved" | "name" | "text" | "geometry" | "layout" | "visual" | "component" | "variables" | "interaction" | "other";
  before?: unknown;
  after?: unknown;
};

export type DesignContextPackage = {
  schemaVersion: 1;
  target: FigmaTarget;
  editorType: FigmaFileType;
  currentSnapshot: unknown;
  semanticHints: SemanticHint[];
  history: {
    snapshots: FigmaVersionSnapshot[];
    changes: FigmaNodeChange[];
    byActor: Array<{ actorKey: string; actor?: FigmaVersionSnapshot["user"]; changes: FigmaNodeChange[] }>;
    unavailableReason?: string;
  };
  artifacts: ArtifactRef[];
  provenance: Array<{ source: "plugin" | "figma_rest" | "codex"; detail: string }>;
  partial: boolean;
  omittedNodes?: number;
  answer?: FigmaQuestionAnswer;
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
  contextPackage?: DesignContextPackage;
};

export type FigmaPluginMeta = {
  pluginVersion: string;
  editorType: "figma" | "figjam";
  fileKey?: string;
  fileName?: string;
  pageName?: string;
  user?: { id?: string | null; name?: string; photoUrl?: string | null };
};

export type FigmaPluginJob = {
  id: string;
  type: "extract_node";
  target: FigmaTarget;
  options: { maxNodes: number; maxJsonBytes: number; maxDimension: number; maxAssets: number; maxAssetBytes: number };
};

export type FigmaPluginExtractionResult = {
  snapshot: unknown;
  nodeCount: number;
  partial: boolean;
  omittedNodes?: number;
  meta: FigmaPluginMeta & { nodeId: string; nodeName?: string; nodeType?: string };
  artifacts: Array<{ slot: string; kind: ArtifactRef["kind"]; mimeType: string; name: string; bytes: number }>;
};

export type FigmaRestOAuthSession = {
  redeemSecret?: string;
  accessToken?: string;
  expiresAt?: number;
  refreshGrant?: string;
  userId?: string;
};

export type CodexAuthFlow = {
  kind: "codex" | "figma";
  state: "waiting" | "complete" | "error";
  authUrl?: string;
  userCode?: string;
  message?: string;
  startedAt: number;
};

export type CodexBridgeSession = {
  flow?: CodexAuthFlow;
  process?: ChildProcess;
  tools: ToolDescriptor[];
};

export type CodexBridgeStatus = {
  connected: boolean;
  transport: "codex";
  beta: true;
  tools?: ToolDescriptor[];
  codex: { installed: boolean; version?: string; authenticated: boolean };
  figmaMcp: { configured: boolean; enabled: boolean; authenticated: boolean; authStatus?: string; url?: string };
  authFlow?: CodexAuthFlow;
  message?: string;
};
