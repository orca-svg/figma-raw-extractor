import type { ConnectionStatus, ExtractionEvent, ExtractionOptions } from "./types";

async function readJson<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T & { message?: string };
  if (!response.ok) throw new Error(payload.message ?? `요청 실패 (${response.status})`);
  return payload;
}

export async function getStatus(): Promise<ConnectionStatus> {
  const response = await fetch("/api/status", { credentials: "same-origin" });
  if (response.status === 401) return readJson<ConnectionStatus>(response);
  return readJson<ConnectionStatus>(response);
}

export async function startOAuth(expectedEmail: string): Promise<string> {
  const response = await fetch("/api/auth/start", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedEmail }),
  });
  return (await readJson<{ authUrl: string }>(response)).authUrl;
}

export async function connectPat(expectedEmail: string, token: string): Promise<ConnectionStatus> {
  const response = await fetch("/api/auth/pat", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedEmail, token }),
  });
  return readJson<ConnectionStatus>(response);
}

export async function disconnect(): Promise<void> {
  const response = await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
  if (!response.ok) throw new Error("연결 해제에 실패했습니다.");
}

export async function streamExtraction(
  options: ExtractionOptions,
  onEvent: (event: ExtractionEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch("/api/extract/stream", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
    body: JSON.stringify(options),
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
    for (const line of lines) {
      if (line.trim()) onEvent(JSON.parse(line) as ExtractionEvent);
    }
    if (done) break;
  }
  if (pending.trim()) onEvent(JSON.parse(pending) as ExtractionEvent);
}
