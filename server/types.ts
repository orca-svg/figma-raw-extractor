import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

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

export type ExtractionInput = {
  target: string;
  expectedEmail?: string;
  searchQuery?: string;
  maxRows: number;
  includeArchived: boolean;
  includeComments: boolean;
  includeTranscript: boolean;
  mode?: "live" | "demo";
};

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

export type EmitEvent = (event: ExtractionEvent) => void | Promise<void>;

export type ParsedToolResult = {
  isError: boolean;
  text: string;
  payload: unknown;
  raw: CallToolResult;
};
