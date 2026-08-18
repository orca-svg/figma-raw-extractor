import type {
  ConnectionStatus,
  CodexAuthFlow,
  ExtractionEvent,
  ExtractionOptions,
  FigmaConnectionStatus,
  FigmaExtractionOptions,
  FigmaRunPayload,
  PluginPairing,
  FigmaTransport,
} from "./types";

async function readJson<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T & { message?: string };
  if (!response.ok) throw new Error(payload.message ?? `요청 실패 (${response.status})`);
  return payload;
}

async function streamNdjson(
  endpoint: string,
  body: unknown,
  onEvent: (event: ExtractionEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(endpoint, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const payload = (await response.json()) as { message?: string };
    throw new Error(payload.message ?? `추출 요청 실패 (${response.status})`);
  }
  if (!response.body) throw new Error("서버가 진행 스트림을 보내지 않았습니다.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) onEvent(JSON.parse(line) as ExtractionEvent);
    if (done) break;
  }
  if (pending.trim()) onEvent(JSON.parse(pending) as ExtractionEvent);
}

export async function getStatus(): Promise<ConnectionStatus> {
  const response = await fetch("/api/notion/status", { credentials: "same-origin" });
  return readJson<ConnectionStatus>(response);
}

export async function startOAuth(expectedEmail: string): Promise<string> {
  const response = await fetch("/api/notion/auth/start", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedEmail }),
  });
  return (await readJson<{ authUrl: string }>(response)).authUrl;
}

export async function connectPat(expectedEmail: string, token: string): Promise<ConnectionStatus> {
  const response = await fetch("/api/notion/auth/pat", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedEmail, token }),
  });
  return readJson<ConnectionStatus>(response);
}

export async function disconnect(): Promise<void> {
  const response = await fetch("/api/notion/auth/logout", { method: "POST", credentials: "same-origin" });
  if (!response.ok) throw new Error("Notion 연결 해제에 실패했습니다.");
}

export function streamExtraction(
  options: ExtractionOptions,
  onEvent: (event: ExtractionEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return streamNdjson("/api/notion/extract/stream", options, onEvent, signal);
}

export async function getFigmaStatus(transport: FigmaTransport): Promise<FigmaConnectionStatus> {
  const response = await fetch(`/api/figma/status?transport=${transport}`, { credentials: "same-origin" });
  return readJson<FigmaConnectionStatus>(response);
}

export async function startFigmaOAuth(): Promise<string> {
  const response = await fetch("/api/figma/auth/start", { method: "POST", credentials: "same-origin" });
  return (await readJson<{ authUrl: string }>(response)).authUrl;
}

export async function disconnectFigmaRemote(): Promise<void> {
  const response = await fetch("/api/figma/auth/logout", { method: "POST", credentials: "same-origin" });
  if (!response.ok) throw new Error("Figma Remote 연결 해제에 실패했습니다.");
}

export async function startPluginPairing(): Promise<PluginPairing> {
  const response = await fetch("/api/figma/plugin/pair/start", { method: "POST", credentials: "same-origin" });
  return readJson<PluginPairing>(response);
}

export async function startFigmaRestOAuth(): Promise<string> {
  const response = await fetch("/api/figma/rest/auth/start", { method: "POST", credentials: "same-origin" });
  return (await readJson<{ authUrl: string }>(response)).authUrl;
}

export async function disconnectFigmaRest(): Promise<void> {
  const response = await fetch("/api/figma/rest/auth/logout", { method: "POST", credentials: "same-origin" });
  if (!response.ok) throw new Error("Figma REST 연결 해제에 실패했습니다.");
}

export async function startCodexLogin(): Promise<CodexAuthFlow> {
  const response = await fetch("/api/figma/codex/auth/start", { method: "POST", credentials: "same-origin" });
  return (await readJson<{ flow: CodexAuthFlow }>(response)).flow;
}

export async function startCodexFigmaOAuth(): Promise<CodexAuthFlow> {
  const response = await fetch("/api/figma/codex/figma/start", { method: "POST", credentials: "same-origin" });
  return (await readJson<{ flow: CodexAuthFlow }>(response)).flow;
}

export async function cancelCodexAuth(): Promise<void> {
  const response = await fetch("/api/figma/codex/auth/cancel", { method: "POST", credentials: "same-origin" });
  if (!response.ok) throw new Error("Codex 인증 취소에 실패했습니다.");
}

export function streamFigmaExtraction(
  options: FigmaExtractionOptions,
  onEvent: (event: ExtractionEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return streamNdjson("/api/figma/extract/stream", options, onEvent, signal);
}

export function streamFigmaQuestion(
  options: FigmaExtractionOptions & { question: string },
  onEvent: (event: ExtractionEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return streamNdjson("/api/figma/questions/stream", options, onEvent, signal);
}

export async function getFigmaRun(runId: string): Promise<FigmaRunPayload> {
  const response = await fetch(`/api/figma/runs/${encodeURIComponent(runId)}`, { credentials: "same-origin" });
  return readJson<FigmaRunPayload>(response);
}
