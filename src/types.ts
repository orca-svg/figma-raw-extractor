export type StepState = "running" | "success" | "warning" | "error" | "skipped";

export type ExtractionEvent = {
  type: "step" | "complete" | "fatal";
  id: string;
  order: number;
  group: "connection" | "discovery" | "search" | "target" | "schema" | "view" | "sql" | "page" | "comments" | "summary";
  label: string;
  state: StepState;
  tool?: string;
  startedAt: string;
  elapsedMs?: number;
  request?: unknown;
  response?: unknown;
  extracted?: unknown;
  message?: string;
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
