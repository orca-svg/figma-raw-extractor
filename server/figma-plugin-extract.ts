import { performance } from "node:perf_hooks";
import { buildSemanticHints, loadFigmaHistory } from "./figma-history.js";
import { FigmaPluginBridge } from "./figma-plugin-bridge.js";
import { runPluginCodexQuestion } from "./figma-question.js";
import { figmaRestOAuthStatus } from "./figma-rest-client.js";
import { storeArtifact } from "./figma-run-store.js";
import { parseFigmaTarget } from "./figma-target.js";
import type {
  DesignContextPackage,
  EmitEvent,
  ExtractionEvent,
  FigmaExtractionInput,
  FigmaRestOAuthSession,
  FigmaRunRecord,
  TraceOrigin,
} from "./types.js";

function byteLength(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value)); } catch { return 0; }
}

export async function runPluginFigmaExtraction(
  bridge: FigmaPluginBridge,
  ownerSessionId: string,
  restSession: FigmaRestOAuthSession,
  input: FigmaExtractionInput,
  run: FigmaRunRecord,
  emit: EmitEvent,
  signal?: AbortSignal,
): Promise<void> {
  let order = 0;
  const publish = async (event: ExtractionEvent, origin: TraceOrigin = "internal") => {
    await emit({ ...event, provider: "figma", runId: run.id, origin });
  };
  const startEvent = async (group: string, label: string, request: unknown, origin: TraceOrigin) => {
    const event: ExtractionEvent = {
      type: "step",
      id: `${String(++order).padStart(2, "0")}-${group}`,
      order,
      group,
      label,
      state: "running",
      startedAt: new Date().toISOString(),
      request,
    };
    await publish(event, origin);
    return { event, started: performance.now(), origin };
  };
  const finishEvent = async (
    started: Awaited<ReturnType<typeof startEvent>>,
    value: { state?: ExtractionEvent["state"]; response?: unknown; extracted?: unknown; message?: string; artifacts?: ExtractionEvent["artifacts"] },
  ) => {
    await publish({
      ...started.event,
      state: value.state ?? "success",
      elapsedMs: Math.round(performance.now() - started.started),
      response: value.response,
      extracted: value.extracted,
      message: value.message,
      artifacts: value.artifacts,
      responseBytes: value.response === undefined ? undefined : byteLength(value.response) + (value.artifacts ?? []).reduce((sum, artifact) => sum + artifact.bytes, 0),
    }, started.origin);
  };

  const targetStep = await startEvent("target", "Figma 링크와 Plugin 대상 확인", { target: input.target }, "internal");
  const target = parseFigmaTarget(input.target);
  run.detectedFileType = target.fileType;
  await finishEvent(targetStep, { response: target, extracted: target });

  const connection = bridge.status(ownerSessionId);
  if (!connection.connected) throw new Error("Figma 플러그인을 먼저 페어링하고 열린 상태로 유지해 주세요.");
  const expectedEditor = target.fileType === "design" ? "figma" : "figjam";
  if (connection.meta.editorType !== expectedEditor) throw new Error(`${target.fileType === "design" ? "Figma Design" : "FigJam"} 파일에서 플러그인을 열어 주세요.`);

  const connectionStep = await startEvent("connection", "Figma Plugin 연결과 열린 파일 확인", { expectedEditor, fileKey: target.fileKey }, "plugin");
  await finishEvent(connectionStep, { response: connection.meta, extracted: { connected: true, editorType: connection.meta.editorType, fileKeyVerified: connection.meta.fileKey === target.fileKey } });

  const pluginStep = await startEvent("current-snapshot", "Plugin으로 현재 노드 snapshot 추출", { target, limits: { nodes: 5_000, jsonBytes: 20 * 1024 * 1024, assets: 20 } }, "plugin");
  const completed = await bridge.requestExtraction(ownerSessionId, target, signal);
  await finishEvent(pluginStep, {
    state: completed.result.partial ? "warning" : "success",
    response: { snapshot: completed.result.snapshot, meta: completed.result.meta, nodeCount: completed.result.nodeCount, partial: completed.result.partial, omittedNodes: completed.result.omittedNodes },
    extracted: { nodeCount: completed.result.nodeCount, partial: completed.result.partial, omittedNodes: completed.result.omittedNodes },
    message: completed.result.partial ? "대상 노드가 커서 일부 하위 노드를 생략했습니다. 더 좁은 레이어 링크를 권장합니다." : undefined,
  });

  const artifactStep = await startEvent("artifacts", "현재 PNG와 하위 이미지·SVG artifact 저장", { candidates: completed.result.artifacts }, "plugin");
  const artifactRefs = [] as NonNullable<ExtractionEvent["artifacts"]>;
  for (const artifact of completed.result.artifacts) {
    const uploaded = completed.artifacts.get(artifact.slot);
    if (!uploaded) continue;
    const stored = storeArtifact(run, {
      data: uploaded.data,
      mimeType: uploaded.mimeType,
      kind: artifact.kind,
      stem: `plugin-${artifact.slot}-${artifact.name}`,
    });
    if (stored) artifactRefs.push(stored);
  }
  await finishEvent(artifactStep, {
    state: artifactRefs.length === completed.result.artifacts.length ? "success" : "warning",
    response: artifactRefs,
    extracted: { artifacts: artifactRefs.length, candidates: completed.result.artifacts.length },
    artifacts: artifactRefs,
    message: artifactRefs.length === completed.result.artifacts.length ? undefined : "실행당 100MB 제한으로 일부 artifact를 저장하지 못했습니다.",
  });

  const semanticsStep = await startEvent("semantics", "노드 의미 근거 구성", { editorType: target.fileType }, "internal");
  const semanticHints = buildSemanticHints(completed.result.snapshot, target.fileType);
  await finishEvent(semanticsStep, { response: semanticHints, extracted: { hints: semanticHints.length } });

  let history: DesignContextPackage["history"] = { snapshots: [], changes: [], byActor: [] };
  const restStatus = figmaRestOAuthStatus(restSession);
  if (restStatus.connected) {
    const versionsStep = await startEvent("versions", "최근 5개 버전 snapshot 조회", { fileKey: target.fileKey, nodeId: target.nodeId, limit: 5 }, "rest");
    try {
      history = await loadFigmaHistory(restSession, target, signal);
      await finishEvent(versionsStep, {
        response: history.snapshots,
        extracted: { versions: history.snapshots.length },
        message: "버전 작성자는 버전 간 관찰된 변경에 거칠게 귀속되며 클릭 단위 감사 로그가 아닙니다.",
      });
      const diffStep = await startEvent("diff", "인접 버전 diff와 동일 작성자 묶음", { versions: history.snapshots.map((snapshot) => snapshot.id) }, "internal");
      await finishEvent(diffStep, { response: { changes: history.changes, byActor: history.byActor }, extracted: { changes: history.changes.length, actors: history.byActor.length, attribution: "coarse_version_attribution" } });
    } catch (error) {
      history = { snapshots: [], changes: [], byActor: [], unavailableReason: error instanceof Error ? error.message : String(error) };
      await finishEvent(versionsStep, { state: "warning", response: [], extracted: { versions: 0 }, message: history.unavailableReason });
      const diffStep = await startEvent("diff", "인접 버전 diff와 동일 작성자 묶음", { versions: [] }, "internal");
      await finishEvent(diffStep, { state: "skipped", response: { changes: [], byActor: [], unavailableReason: history.unavailableReason }, extracted: { changes: 0, actors: 0 }, message: history.unavailableReason });
    }
  } else {
    history = { snapshots: [], changes: [], byActor: [], unavailableReason: "Figma REST OAuth를 연결하면 최근 5개 버전의 작성자와 변경을 비교할 수 있습니다." };
    const versionsStep = await startEvent("versions", "최근 5개 버전 snapshot 조회", { limit: 5 }, "rest");
    await finishEvent(versionsStep, { state: "skipped", response: [], extracted: { versions: 0 }, message: history.unavailableReason });
    const diffStep = await startEvent("diff", "인접 버전 diff와 동일 작성자 묶음", { versions: [] }, "internal");
    await finishEvent(diffStep, { state: "skipped", response: { changes: [], byActor: [], unavailableReason: history.unavailableReason }, extracted: { changes: 0, actors: 0 }, message: history.unavailableReason });
  }

  const context: DesignContextPackage = {
    schemaVersion: 1,
    target,
    editorType: target.fileType,
    currentSnapshot: completed.result.snapshot,
    semanticHints,
    history,
    artifacts: artifactRefs,
    provenance: [
      { source: "plugin", detail: "열린 Figma 파일의 Plugin API에서 현재 노드와 artifact를 읽었습니다." },
      ...(restStatus.connected ? [{ source: "figma_rest" as const, detail: "Figma REST API에서 최근 버전 메타데이터와 노드 스냅샷을 읽었습니다." }] : []),
    ],
    partial: completed.result.partial,
    omittedNodes: completed.result.omittedNodes,
  };
  run.contextPackage = context;

  if (input.question) {
    const answerStep = await startEvent("answer", "추출 근거로 Codex에 질문", { question: input.question }, "codex");
    const answer = await runPluginCodexQuestion(input.question, context, run.artifacts, signal);
    context.answer = answer;
    await finishEvent(answerStep, {
      response: answer,
      extracted: { evidence: answer.evidence.length, uncertainties: answer.uncertainties.length },
      message: "Plugin·REST 추출 결과만 근거로 생성한 독립 질문 답변입니다.",
    });
  }

  await publish({
    type: "complete",
    id: `${String(++order).padStart(2, "0")}-summary`,
    order,
    group: "summary",
    label: input.question ? "Plugin 추출과 질문 완료" : "Plugin 추출 완료",
    state: history.unavailableReason || completed.result.partial ? "warning" : "success",
    startedAt: new Date().toISOString(),
    extracted: {
      transport: "plugin",
      fileType: target.fileType,
      nodes: completed.result.nodeCount,
      versions: history.snapshots.length,
      changes: history.changes.length,
      actors: history.byActor.length,
      artifacts: artifactRefs.length,
      answered: Boolean(context.answer),
      partial: context.partial,
    },
    message: input.question ? "Plugin의 최신 노드를 추출하고 Codex가 질문에 답했습니다." : "Plugin의 최신 노드와 버전 변화 근거를 추출했습니다.",
  }, "internal");
}
