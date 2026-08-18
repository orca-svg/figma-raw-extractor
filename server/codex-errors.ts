type JsonRecord = Record<string, unknown>;

function nestedMessage(value: unknown): string | undefined {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return undefined;
    try { return nestedMessage(JSON.parse(text)) ?? text; } catch { return text; }
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as JsonRecord;
  const parts = [
    typeof record.code === "string" ? record.code : undefined,
    nestedMessage(record.error),
    nestedMessage(record.message),
  ].filter((part): part is string => Boolean(part));
  return parts.length ? [...new Set(parts)].join(" ") : undefined;
}

function jsonlFailure(stdout: string): string | undefined {
  let failure: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as JsonRecord;
      if (event.type === "error" || event.type === "turn.failed") failure = nestedMessage(event.error) ?? failure;
    } catch {
      // Codex JSONL may be mixed with non-event output. Raw text is never shown to the user.
    }
  }
  return failure;
}

export function codexQuestionFailureMessage(stdout: string, _stderr: string, exitCode: number | null): string {
  const failure = jsonlFailure(stdout)?.toLowerCase() ?? "";
  if (/invalid_json_schema|response.format|output.schema|schema/.test(failure)) {
    return "Codex 답변 출력 형식을 준비하지 못했습니다. Trace Studio를 다시 빌드한 뒤 재시도해 주세요.";
  }
  if (/unauthorized|authentication|not.logged.in|login.required|auth.required/.test(failure)) {
    return "Codex 인증이 만료되었습니다. Codex 연결 상태를 다시 확인해 주세요.";
  }
  if (/model.*(?:not.found|unsupported|unavailable)|unknown.model/.test(failure)) {
    return "설정된 Codex 모델을 사용할 수 없습니다. 모델 설정을 확인해 주세요.";
  }
  if (/rate.?limit|usage.?limit|quota/.test(failure)) {
    return "Codex 사용 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.";
  }
  if (/network|stream.disconnected|connection|timeout/.test(failure)) {
    return "Codex 연결이 중단되었습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.";
  }
  return `Codex 질문을 완료하지 못했습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요. (exit ${exitCode ?? "unknown"})`;
}
