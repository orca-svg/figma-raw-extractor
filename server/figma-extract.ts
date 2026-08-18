import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { parseToolResult, resolveTool } from "./extract.js";
import { parseFigmaTarget } from "./figma-target.js";
import { storeArtifact } from "./figma-run-store.js";
import type {
  ArtifactRef,
  EmitEvent,
  ExtractionEvent,
  FigmaExtractionInput,
  FigmaFileType,
  FigmaRunRecord,
  FigmaTarget,
  McpAdapter,
  StepState,
  ToolDescriptor,
} from "./types.js";

type CapturedResult = {
  response: unknown;
  text: string;
  payload: unknown;
  isError: boolean;
  artifacts: ArtifactRef[];
  responseBytes: number;
  omittedArtifacts: number;
};

const URL_RE = /https:\/\/[^\s"'<>\\)]+/g;

function toolArgs(target: FigmaTarget | undefined): Record<string, unknown> {
  return target ? { fileKey: target.fileKey, nodeId: target.nodeId } : {};
}

function artifactKind(tool: string): ArtifactRef["kind"] {
  if (/screenshot|design_context|figjam/.test(tool)) return "screenshot";
  if (/asset/.test(tool)) return "asset";
  return "binary";
}

function byteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return 0;
  }
}

async function captureToolResult(
  result: CallToolResult,
  run: FigmaRunRecord,
  order: number,
  tool: string,
): Promise<CapturedResult> {
  const artifacts: ArtifactRef[] = [];
  let omittedArtifacts = 0;
  const content: unknown[] = [];

  for (let index = 0; index < (result.content ?? []).length; index += 1) {
    const block = result.content[index] as unknown as Record<string, unknown>;
    if ((block.type === "image" || block.type === "audio") && typeof block.data === "string" && typeof block.mimeType === "string") {
      const data = Uint8Array.from(Buffer.from(block.data, "base64"));
      const artifact = storeArtifact(run, {
        data,
        mimeType: block.mimeType,
        kind: artifactKind(tool),
        stem: `${String(order).padStart(2, "0")}-${tool}-${index + 1}`,
      });
      if (artifact) artifacts.push(artifact);
      else omittedArtifacts += 1;
      const { data: _data, ...rest } = block;
      content.push({
        ...rest,
        data: artifact ? { storedAs: artifact.path, bytes: artifact.bytes } : { omitted: "100MB run limit" },
      });
      continue;
    }

    const resource = block.type === "resource" && typeof block.resource === "object" && block.resource !== null
      ? block.resource as Record<string, unknown>
      : undefined;
    if (resource && typeof resource.blob === "string") {
      const mimeType = typeof resource.mimeType === "string" ? resource.mimeType : "application/octet-stream";
      const data = Uint8Array.from(Buffer.from(resource.blob, "base64"));
      const artifact = storeArtifact(run, {
        data,
        mimeType,
        kind: "binary",
        stem: `${String(order).padStart(2, "0")}-${tool}-resource-${index + 1}`,
      });
      if (artifact) artifacts.push(artifact);
      else omittedArtifacts += 1;
      const { blob: _blob, ...resourceRest } = resource;
      content.push({
        ...block,
        resource: {
          ...resourceRest,
          blob: artifact ? { storedAs: artifact.path, bytes: artifact.bytes } : { omitted: "100MB run limit" },
        },
      });
      continue;
    }
    content.push(block);
  }

  const sanitized = { ...result, content };
  const parsed = parseToolResult(result);

  if (/get_screenshot|download_assets/.test(tool)) {
    const responseCorpus = `${parsed.text}\n${JSON.stringify(sanitized)}`;
    const urls = [...new Set((responseCorpus.match(URL_RE) ?? []).map((url) => url.replace(/[.,;]$/, "")))].slice(0, 20);
    for (let index = 0; index < urls.length; index += 1) {
      try {
        const response = await fetch(urls[index], { signal: AbortSignal.timeout(15_000) });
        if (!response.ok) continue;
        const contentType = response.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream";
        if (!/^(?:image\/|application\/(?:pdf|octet-stream))/.test(contentType)) continue;
        const data = new Uint8Array(await response.arrayBuffer());
        const artifact = storeArtifact(run, {
          data,
          mimeType: contentType,
          kind: artifactKind(tool),
          stem: `${String(order).padStart(2, "0")}-${tool}-download-${index + 1}`,
        });
        if (artifact) artifacts.push(artifact);
        else omittedArtifacts += 1;
      } catch {
        // The signed URL remains in the raw response when immediate download fails.
      }
    }
  }

  return {
    response: sanitized,
    text: parsed.text,
    payload: parsed.payload,
    isError: parsed.isError,
    artifacts,
    responseBytes: byteLength(sanitized) + artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0),
    omittedArtifacts,
  };
}

function deterministicSummary(tool: string, result: CapturedResult) {
  const payload = typeof result.payload === "object" && result.payload !== null ? result.payload as Record<string, unknown> : undefined;
  const content = (result.response as { content?: Array<Record<string, unknown>> })?.content ?? [];
  return {
    textBlocks: content.filter((block) => block.type === "text").length,
    imageBlocks: content.filter((block) => block.type === "image").length,
    resourceBlocks: content.filter((block) => block.type === "resource" || block.type === "resource_link").length,
    payloadKeys: payload ? Object.keys(payload).length : undefined,
    entries: payload ? Object.keys(payload).length : undefined,
    textCharacters: result.text.length,
    responseBytes: result.responseBytes,
    artifactCount: result.artifacts.length,
    omittedArtifacts: result.omittedArtifacts,
    truncated: /truncat|too large|metadata[- ]?only|output size/i.test(result.text),
    tool,
  };
}

function isWrongDesignType(result: CapturedResult): boolean {
  return result.isError && /figjam|board|not supported|file type|design file/i.test(result.text);
}

export async function runFigmaExtraction(
  adapter: McpAdapter,
  input: FigmaExtractionInput,
  run: FigmaRunRecord,
  emit: EmitEvent,
): Promise<void> {
  let order = 0;
  const finished: ExtractionEvent[] = [];

  const publish = async (event: ExtractionEvent) => {
    await emit({ ...event, provider: "figma", runId: run.id, origin: event.tool ? "mcp" : "internal" });
  };

  const emitSkipped = async (group: string, label: string, message: string, tool?: string) => {
    const event: ExtractionEvent = {
      type: "step",
      id: `${String(++order).padStart(2, "0")}-${group}`,
      order,
      group,
      label,
      state: "skipped",
      tool,
      startedAt: new Date().toISOString(),
      message,
    };
    finished.push(event);
    await publish(event);
  };

  const runInternal = async (group: string, label: string, request: unknown, action: () => unknown) => {
    const eventOrder = ++order;
    const base: ExtractionEvent = {
      type: "step",
      id: `${String(eventOrder).padStart(2, "0")}-${group}`,
      order: eventOrder,
      group,
      label,
      state: "running",
      startedAt: new Date().toISOString(),
      request,
    };
    await publish(base);
    try {
      const response = action();
      const event: ExtractionEvent = { ...base, state: "success", elapsedMs: 0, response, extracted: response, responseBytes: byteLength(response) };
      finished.push(event);
      await publish(event);
      return response;
    } catch (error) {
      const event: ExtractionEvent = { ...base, state: "error", elapsedMs: 0, message: error instanceof Error ? error.message : String(error) };
      finished.push(event);
      await publish(event);
      return undefined;
    }
  };

  const runTool = async (
    group: string,
    label: string,
    tool: string,
    request: Record<string, unknown>,
  ): Promise<CapturedResult | undefined> => {
    const eventOrder = ++order;
    const started = performance.now();
    const base: ExtractionEvent = {
      type: "step",
      id: `${String(eventOrder).padStart(2, "0")}-${group}`,
      order: eventOrder,
      group,
      label,
      state: "running",
      tool,
      request,
      startedAt: new Date().toISOString(),
    };
    await publish(base);
    try {
      const result = await captureToolResult(await adapter.callTool(tool, request), run, eventOrder, tool);
      const state: StepState = result.isError ? "error" : result.omittedArtifacts ? "warning" : "success";
      const event: ExtractionEvent = {
        ...base,
        state,
        elapsedMs: Math.round(performance.now() - started),
        response: result.response,
        extracted: deterministicSummary(tool, result),
        responseBytes: result.responseBytes,
        artifacts: result.artifacts,
        message: result.omittedArtifacts ? "실행 번들 100MB 제한으로 일부 artifact를 제외했습니다." : undefined,
      };
      finished.push(event);
      await publish(event);
      return result;
    } catch (error) {
      const event: ExtractionEvent = {
        ...base,
        state: "error",
        elapsedMs: Math.round(performance.now() - started),
        message: error instanceof Error ? error.message : String(error),
      };
      finished.push(event);
      await publish(event);
      return undefined;
    }
  };

  const discoveryOrder = ++order;
  const discoveryBase: ExtractionEvent = {
    type: "step",
    id: `${String(discoveryOrder).padStart(2, "0")}-discovery`,
    order: discoveryOrder,
    group: "discovery",
    label: "사용 가능한 Figma MCP Tool 확인",
    state: "running",
    tool: "tools/list",
    startedAt: new Date().toISOString(),
  };
  await publish(discoveryBase);
  let tools: ToolDescriptor[];
  try {
    const started = performance.now();
    tools = await adapter.listTools();
    run.tools = tools;
    const event: ExtractionEvent = {
      ...discoveryBase,
      state: "success",
      elapsedMs: Math.round(performance.now() - started),
      response: tools,
      extracted: { count: tools.length, tools: tools.map((tool) => tool.name) },
      responseBytes: byteLength(tools),
    };
    finished.push(event);
    await publish(event);
  } catch (error) {
    const event: ExtractionEvent = { ...discoveryBase, state: "error", message: error instanceof Error ? error.message : String(error) };
    finished.push(event);
    await publish(event);
    throw error;
  }

  const resolve = (canonical: string) => resolveTool(tools, canonical);
  let target: FigmaTarget | undefined;
  if (input.targetMode === "link") {
    target = await runInternal("target", "Figma 링크와 노드 범위 확인", { target: input.target }, () => parseFigmaTarget(input.target)) as FigmaTarget | undefined;
    if (!target) throw new Error("Figma 대상을 해석하지 못했습니다.");
    run.detectedFileType = target.fileType;
  } else {
    await runInternal("target", "Figma Desktop의 현재 선택 사용", { targetMode: "selection" }, () => ({ targetMode: "selection", transport: input.transport }));
  }

  if (input.transport === "remote") {
    const whoami = resolve("whoami");
    if (whoami) await runTool("connection", "Remote 계정·플랜·seat 확인", whoami, {});
    else await emitSkipped("connection", "Remote 계정·플랜·seat 확인", "이 연결에는 whoami Tool이 없습니다.");
  }

  let contextResult: CapturedResult | undefined;
  let figjamResult: CapturedResult | undefined;
  let fileType: FigmaFileType | undefined = target?.fileType;
  const designTool = resolve("get_design_context");
  const figjamTool = resolve("get_figjam");

  if (!fileType && input.targetMode === "selection") {
    if (designTool) {
      const request = {
        clientFrameworks: input.clientFrameworks || "unknown",
        clientLanguages: input.clientLanguages || "unknown",
        ...(input.includeCodeConnect ? {} : { disableCodeConnect: true }),
      };
      contextResult = await runTool("context", "현재 선택을 Figma Design으로 읽기", designTool, request);
      if (contextResult && !contextResult.isError) fileType = "design";
      else if (contextResult && !isWrongDesignType(contextResult)) {
        await emitSkipped("figjam", "현재 선택을 FigJam으로 다시 읽기", "Design 호출이 파일 유형 외의 이유로 실패해 자동 전환하지 않았습니다.");
      }
    }
    if (!fileType && figjamTool && (!contextResult || isWrongDesignType(contextResult))) {
      figjamResult = await runTool("figjam", "현재 선택을 FigJam으로 읽기", figjamTool, { includeImagesOfNodes: true });
      if (figjamResult && !figjamResult.isError) fileType = "figjam";
    }
    if (!fileType) throw new Error("현재 선택이 Figma Design 또는 FigJam 노드인지 확인하지 못했습니다.");
    run.detectedFileType = fileType;
  }

  if (fileType === "design") {
    if (!contextResult) {
      if (designTool) {
        contextResult = await runTool("context", "선택 노드의 디자인 컨텍스트 조회", designTool, {
          ...toolArgs(target),
          clientFrameworks: input.clientFrameworks || "unknown",
          clientLanguages: input.clientLanguages || "unknown",
          ...(input.includeCodeConnect ? {} : { disableCodeConnect: true }),
        });
      } else await emitSkipped("context", "선택 노드의 디자인 컨텍스트 조회", "이 연결에는 get_design_context Tool이 없습니다.");
    }

    if (contextResult && (/truncat|too large|metadata[- ]?only|output size/i.test(contextResult.text))) {
      const metadataTool = resolve("get_metadata");
      if (metadataTool) await runTool("metadata", "큰 응답의 노드 구조만 다시 조회", metadataTool, toolArgs(target));
      else await emitSkipped("metadata", "큰 응답의 노드 구조만 다시 조회", "응답이 크지만 get_metadata Tool이 없습니다.");
    }

    const screenshot = resolve("get_screenshot");
    if (screenshot) await runTool("screenshot", "선택 노드의 기준 이미지 조회", screenshot, { ...toolArgs(target), maxDimension: 2048 });
    else await emitSkipped("screenshot", "선택 노드의 기준 이미지 조회", "이 연결에는 get_screenshot Tool이 없습니다.");

    const optionalCalls: Array<[boolean, string, string, string, Record<string, unknown>]> = [
      [input.includeVariables, "variables", "사용된 변수와 스타일 조회", "get_variable_defs", toolArgs(target)],
      [input.includeCodeConnect, "code-connect", "Code Connect 매핑 조회", "get_code_connect_map", { ...toolArgs(target), ...(input.codeConnectLabel ? { codeConnectLabel: input.codeConnectLabel } : {}) }],
      [input.includeMotion, "motion", "선택 노드와 하위 모션 조회", "get_motion_context", { ...toolArgs(target), clientFrameworks: input.clientFrameworks || "unknown", clientLanguages: input.clientLanguages || "unknown", recursive: true }],
      [input.includeLibraries && input.transport === "remote", "libraries", "파일의 디자인 라이브러리 조회", "get_libraries", target ? { fileKey: target.fileKey } : {}],
      [input.includeAssets && input.transport === "remote", "assets", "선택 노드의 원본 자산 다운로드", "download_assets", toolArgs(target)],
    ];
    for (const [enabled, group, label, canonical, request] of optionalCalls) {
      if (!enabled) {
        await emitSkipped(group, label, "고급 옵션에서 사용하지 않도록 설정했습니다.");
        continue;
      }
      const tool = resolve(canonical);
      if (tool) await runTool(group, label, tool, request);
      else await emitSkipped(group, label, `이 연결에는 ${canonical} Tool이 없습니다.`);
    }
  } else {
    if (!figjamResult) {
      if (figjamTool) figjamResult = await runTool("figjam", "FigJam 노드 구조와 이미지 조회", figjamTool, { ...toolArgs(target), includeImagesOfNodes: true });
      else await emitSkipped("figjam", "FigJam 노드 구조와 이미지 조회", "이 연결에는 get_figjam Tool이 없습니다.");
    }
    const screenshot = resolve("get_screenshot");
    if (screenshot) await runTool("screenshot", "FigJam 선택의 기준 이미지 조회", screenshot, { ...toolArgs(target), maxDimension: 2048 });
    else await emitSkipped("screenshot", "FigJam 선택의 기준 이미지 조회", "이 연결에는 get_screenshot Tool이 없습니다.");
    if (input.includeAssets && input.transport === "remote") {
      const assets = resolve("download_assets");
      if (assets) await runTool("assets", "FigJam 선택의 원본 자산 다운로드", assets, toolArgs(target));
      else await emitSkipped("assets", "FigJam 선택의 원본 자산 다운로드", "이 연결에는 download_assets Tool이 없습니다.");
    } else {
      await emitSkipped("assets", "FigJam 선택의 원본 자산 다운로드", "Remote 자산 옵션이 꺼져 있어 실행하지 않았습니다.");
    }
  }

  const errors = finished.filter((event) => event.state === "error").length;
  const skipped = finished.filter((event) => event.state === "skipped").length;
  await publish({
    type: "complete",
    id: `${String(++order).padStart(2, "0")}-summary`,
    order,
    group: "summary",
    label: "Figma 추출 완료",
    state: errors ? "warning" : "success",
    startedAt: new Date().toISOString(),
    extracted: {
      fileType,
      transport: input.transport,
      toolCount: tools.length,
      calls: finished.length,
      errors,
      skipped,
      artifacts: run.artifacts.size,
      artifactBytes: run.artifactBytes,
    },
    message: `${fileType === "figjam" ? "FigJam" : "Figma Design"}에서 MCP Tool ${finished.filter((event) => event.tool).length}개를 추적했습니다.`,
  });
}
