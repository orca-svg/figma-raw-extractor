import { randomUUID } from "node:crypto";
import { strToU8, zipSync, type Zippable } from "fflate";
import type { ArtifactRef, ExtractionEvent, FigmaExtractionInput, FigmaRunRecord, StoredArtifact } from "./types.js";

export const RUN_TTL_MS = 30 * 60 * 1000;
export const MAX_RUN_ARTIFACT_BYTES = 100 * 1024 * 1024;
const MAX_SESSION_RUNS = 3;

function extensionFor(mimeType: string): string {
  const normalized = mimeType.toLowerCase().split(";")[0];
  if (normalized === "image/jpeg") return "jpg";
  if (normalized === "image/svg+xml") return "svg";
  if (normalized === "application/pdf") return "pdf";
  if (normalized.includes("/")) return normalized.split("/")[1].replace(/[^a-z0-9]+/g, "") || "bin";
  return "bin";
}

export function createFigmaRun(sessionId: string, input: FigmaExtractionInput): FigmaRunRecord {
  const now = Date.now();
  return {
    id: randomUUID(),
    sessionId,
    startedAt: new Date(now).toISOString(),
    expiresAt: now + RUN_TTL_MS,
    input,
    tools: [],
    events: [],
    artifacts: new Map(),
    artifactBytes: 0,
  };
}

export function addRunToSession(runs: Map<string, FigmaRunRecord>, run: FigmaRunRecord): void {
  cleanupRuns(runs);
  runs.set(run.id, run);
  const ordered = [...runs.values()].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  while (ordered.length > MAX_SESSION_RUNS) {
    const oldest = ordered.shift();
    if (oldest) runs.delete(oldest.id);
  }
}

export function cleanupRuns(runs: Map<string, FigmaRunRecord>): void {
  const now = Date.now();
  for (const [id, run] of runs) if (run.expiresAt <= now) runs.delete(id);
}

export function upsertRunEvent(run: FigmaRunRecord, event: ExtractionEvent): void {
  const index = run.events.findIndex((candidate) => candidate.id === event.id);
  if (index === -1) run.events.push(event);
  else run.events[index] = event;
  run.events.sort((a, b) => a.order - b.order);
  if (event.type === "complete" || event.type === "fatal") run.completedAt = new Date().toISOString();
}

export function storeArtifact(
  run: FigmaRunRecord,
  input: { data: Uint8Array; mimeType: string; kind: ArtifactRef["kind"]; stem: string },
): ArtifactRef | undefined {
  if (run.artifactBytes + input.data.byteLength > MAX_RUN_ARTIFACT_BYTES) return undefined;
  const id = randomUUID();
  const safeStem = input.stem.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "artifact";
  const folder = input.kind === "screenshot" ? "screenshots" : input.kind === "asset" ? "assets" : "binary";
  const path = `artifacts/${folder}/${safeStem}-${id.slice(0, 8)}.${extensionFor(input.mimeType)}`;
  const artifact: StoredArtifact = {
    id,
    path,
    mimeType: input.mimeType,
    bytes: input.data.byteLength,
    kind: input.kind,
    data: input.data,
  };
  run.artifacts.set(id, artifact);
  run.artifactBytes += input.data.byteLength;
  return { id, path, mimeType: artifact.mimeType, bytes: artifact.bytes, kind: artifact.kind };
}

function publicRun(run: FigmaRunRecord) {
  return {
    manifest: {
      schemaVersion: 1,
      provider: "figma",
      runId: run.id,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      expiresAt: new Date(run.expiresAt).toISOString(),
      input: run.input,
      detectedFileType: run.detectedFileType,
      tools: run.tools,
      artifactBytes: run.artifactBytes,
      artifacts: [...run.artifacts.values()].map(({ data: _data, ...artifact }) => artifact),
    },
    events: run.events,
  };
}

export function serializeFigmaRun(run: FigmaRunRecord): ReturnType<typeof publicRun> {
  return publicRun(run);
}

export function buildFigmaRunZip(run: FigmaRunRecord): Uint8Array {
  const payload = publicRun(run);
  const files: Zippable = {
    "manifest.json": strToU8(JSON.stringify(payload.manifest, null, 2)),
    "trace.ndjson": strToU8(run.events.map((event) => JSON.stringify(event)).join("\n")),
    "README.md": strToU8([
      "# MCP Trace Studio · Figma extraction",
      "",
      `- Run: ${run.id}`,
      `- Started: ${run.startedAt}`,
      `- Transport: ${run.input.transport}`,
      `- Target mode: ${run.input.targetMode}`,
      `- Detected type: ${run.detectedFileType ?? "unknown"}`,
      "",
      "이 번들은 AI 해석이나 코드 생성을 포함하지 않습니다. trace.ndjson과 responses의 값은 실제 MCP 호출 기록입니다.",
    ].join("\n")),
  };

  for (const event of run.events) {
    if (event.state === "running" || event.response === undefined) continue;
    const tool = (event.tool ?? "internal").replace(/[^a-zA-Z0-9_-]+/g, "-");
    files[`responses/${String(event.order).padStart(2, "0")}-${tool}.json`] = strToU8(JSON.stringify(event.response, null, 2));
  }
  for (const artifact of run.artifacts.values()) files[artifact.path] = artifact.data;
  return zipSync(files, { level: 6 });
}
