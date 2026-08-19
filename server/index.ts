import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import { DemoMcpAdapter } from "./demo-adapter.js";
import { runExtraction, extractIdentity, parseToolResult, resolveTool } from "./extract.js";
import { parseNotionTarget } from "./notion-target.js";
import { FigmaDemoAdapter, FIGMA_DEMO_TARGET } from "./figma-demo-adapter.js";
import { runFigmaExtraction } from "./figma-extract.js";
import { runPluginFigmaExtraction } from "./figma-plugin-extract.js";
import { bearerToken, FigmaPluginBridge } from "./figma-plugin-bridge.js";
import {
  cancelCodexAuth,
  createCodexBridgeSession,
  inspectCodexBridge,
  runCodexFigmaExtraction,
  startCodexAccountLogin,
  startCodexFigmaLogin,
} from "./codex-figma-bridge.js";
import {
  beginFigmaRemoteOAuth,
  connectToFigmaDesktop,
  connectToFigmaRemote,
  createFigmaOAuthSession,
  finishFigmaRemoteOAuth,
  type FigmaOAuthSession,
} from "./figma-mcp-client.js";
import {
  beginFigmaRestOAuth,
  clearFigmaRestOAuth,
  figmaRestOAuthStatus,
  finishFigmaRestOAuth,
} from "./figma-rest-client.js";
import {
  addRunToSession,
  buildFigmaRunZip,
  cleanupRuns,
  createFigmaRun,
  serializeFigmaRun,
  upsertRunEvent,
} from "./figma-run-store.js";
import { connectToNotionMcp } from "./mcp-client.js";
import {
  buildAuthorizationUrl,
  createPkce,
  createState,
  discoverOAuthMetadata,
  exchangeCode,
  refreshToken,
  registerClient,
  type ClientCredentials,
  type OAuthMetadata,
  type TokenResponse,
} from "./oauth.js";
import type {
  ExtractionEvent,
  FigmaExtractionInput,
  FigmaPluginMeta,
  FigmaRunRecord,
  FigmaRestOAuthSession,
  McpAdapter,
  NotionExtractionInput,
  CodexBridgeSession,
} from "./types.js";

type NotionSession = {
  expectedEmail?: string;
  oauth?: {
    metadata: OAuthMetadata;
    credentials: ClientCredentials;
    verifier: string;
    state: string;
    createdAt: number;
  };
  tokens?: TokenResponse & { expiresAt?: number; kind: "oauth" | "pat" };
  identity?: ReturnType<typeof extractIdentity>;
  refreshPromise?: Promise<string>;
};

type FigmaSession = {
  oauth: FigmaOAuthSession;
  rest: FigmaRestOAuthSession;
  codex: CodexBridgeSession;
  runs: Map<string, FigmaRunRecord>;
};

type Session = {
  id: string;
  notion: NotionSession;
  figma: FigmaSession;
};

const sessions = new Map<string, Session>();
const figmaPluginBridge = new FigmaPluginBridge();
const app = express();
const PORT = Number(process.env.PORT ?? 8787);
const API_ORIGIN = process.env.API_ORIGIN ?? `http://127.0.0.1:${PORT}`;
const APP_ORIGIN = process.env.APP_ORIGIN ?? (process.env.NODE_ENV === "production" ? API_ORIGIN : "http://127.0.0.1:5173");
const NOTION_CALLBACK_URL = `${API_ORIGIN}/api/notion/auth/callback`;
const FIGMA_CALLBACK_URL = `${API_ORIGIN}/api/figma/auth/callback`;
const COOKIE = "mcp_trace_studio_session";

app.disable("x-powered-by");
app.use("/api/figma/plugin/jobs/:jobId/result", express.json({ limit: "22mb" }));
app.use(express.json({ limit: "64kb" }));

function parseCookies(req: Request): Record<string, string> {
  return Object.fromEntries(
    (req.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([key, value]) => Boolean(key && value))
      .map(([key, value]) => [decodeURIComponent(key), decodeURIComponent(value)]),
  );
}

function createSession(): Session {
  return {
    id: randomUUID(),
    notion: {},
    figma: { oauth: createFigmaOAuthSession(), rest: {}, codex: createCodexBridgeSession(), runs: new Map() },
  };
}

function getSession(req: Request, res: Response): Session {
  const existingId = parseCookies(req)[COOKIE];
  const existing = existingId ? sessions.get(existingId) : undefined;
  if (existing) return existing;
  const session = createSession();
  sessions.set(session.id, session);
  res.cookie(COOKIE, session.id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 12,
  });
  return session;
}

function responseBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return 0;
  }
}

function publicNotionIdentity(session: NotionSession) {
  return session.identity
    ? {
        workspace: session.identity.workspace,
        user: session.identity.user,
        current_tool_access: session.identity.current_tool_access,
      }
    : undefined;
}

async function readNotionIdentity(adapter: McpAdapter) {
  const tools = await adapter.listTools();
  const fetchTool = resolveTool(tools, "fetch");
  if (!fetchTool) throw new Error("fetch 도구가 없습니다.");
  const result = parseToolResult(await adapter.callTool(fetchTool, { id: "self" }));
  if (result.isError) throw new Error(result.text || "계정 확인에 실패했습니다.");
  return extractIdentity(result.payload);
}

async function ensureNotionAccessToken(session: NotionSession): Promise<string> {
  const tokens = session.tokens;
  if (!tokens?.access_token) throw new Error("NOT_CONNECTED");
  if (tokens.kind === "pat" || !tokens.refresh_token || !tokens.expiresAt || tokens.expiresAt - Date.now() > 10 * 60 * 1000) {
    return tokens.access_token;
  }
  if (!session.oauth) throw new Error("REAUTH_REQUIRED");
  if (!session.refreshPromise) {
    session.refreshPromise = refreshToken({
      refreshToken: tokens.refresh_token,
      metadata: session.oauth.metadata,
      credentials: session.oauth.credentials,
    })
      .then((next) => {
        session.tokens = {
          ...tokens,
          ...next,
          refresh_token: next.refresh_token ?? tokens.refresh_token,
          expiresAt: next.expires_in ? Date.now() + next.expires_in * 1000 : undefined,
          kind: "oauth",
        };
        return session.tokens.access_token;
      })
      .catch((error) => {
        if (error instanceof Error && error.message === "REAUTH_REQUIRED") session.tokens = undefined;
        throw error;
      })
      .finally(() => {
        session.refreshPromise = undefined;
      });
  }
  return session.refreshPromise;
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    endpoints: { notion: "https://mcp.notion.com/mcp", figmaDesktop: "http://127.0.0.1:3845/mcp", figmaRemote: "https://mcp.figma.com/mcp", figmaPlugin: "http://127.0.0.1:8787/api/figma/plugin" },
    now: new Date().toISOString(),
  });
});

const notionStatus = async (req: Request, res: Response) => {
  const session = getSession(req, res).notion;
  if (!session.tokens) return res.json({ connected: false });
  let adapter: McpAdapter | undefined;
  try {
    adapter = await connectToNotionMcp(await ensureNotionAccessToken(session));
    session.identity = await readNotionIdentity(adapter);
    return res.json({ connected: true, authKind: session.tokens.kind, identity: publicNotionIdentity(session), expectedEmail: session.expectedEmail });
  } catch (error) {
    if (error instanceof Error && /REAUTH_REQUIRED|NOT_CONNECTED|401|unauthorized/i.test(error.message)) session.tokens = undefined;
    return res.status(401).json({ connected: false, message: error instanceof Error ? error.message : String(error) });
  } finally {
    await adapter?.close().catch(() => undefined);
  }
};
app.get(["/api/notion/status", "/api/status"], notionStatus);

const notionAuthStart = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const session = getSession(req, res).notion;
    session.expectedEmail = typeof req.body.expectedEmail === "string" ? req.body.expectedEmail.trim() : undefined;
    const metadata = await discoverOAuthMetadata();
    const credentials = await registerClient(metadata, NOTION_CALLBACK_URL, APP_ORIGIN);
    const { verifier, challenge } = createPkce();
    const state = createState();
    session.oauth = { metadata, credentials, verifier, state, createdAt: Date.now() };
    const authUrl = buildAuthorizationUrl({ metadata, clientId: credentials.client_id, redirectUri: NOTION_CALLBACK_URL, challenge, state });
    res.json({ authUrl });
  } catch (error) {
    next(error);
  }
};
app.post(["/api/notion/auth/start", "/api/auth/start"], notionAuthStart);

const notionAuthCallback = async (req: Request, res: Response) => {
  const session = getSession(req, res).notion;
  const oauth = session.oauth;
  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  const state = typeof req.query.state === "string" ? req.query.state : undefined;
  const oauthError = typeof req.query.error === "string" ? req.query.error : undefined;
  if (oauthError) return res.redirect(`${APP_ORIGIN}/notion?auth=error&reason=${encodeURIComponent(oauthError)}`);
  if (!oauth || !code || state !== oauth.state || Date.now() - oauth.createdAt > 10 * 60 * 1000) {
    return res.redirect(`${APP_ORIGIN}/notion?auth=error&reason=invalid_callback`);
  }
  try {
    const tokens = await exchangeCode({ code, verifier: oauth.verifier, metadata: oauth.metadata, credentials: oauth.credentials, redirectUri: NOTION_CALLBACK_URL });
    session.tokens = { ...tokens, expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined, kind: "oauth" };
    session.oauth = { ...oauth, verifier: "", state: "", createdAt: Date.now() };
    return res.redirect(`${APP_ORIGIN}/notion?auth=connected`);
  } catch (error) {
    return res.redirect(`${APP_ORIGIN}/notion?auth=error&reason=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`);
  }
};
app.get(["/api/notion/auth/callback", "/api/auth/callback"], notionAuthCallback);

const notionPat = async (req: Request, res: Response, next: NextFunction) => {
  const session = getSession(req, res).notion;
  const token = typeof req.body.token === "string" ? req.body.token.trim() : "";
  if (!token) return res.status(400).json({ message: "개인 토큰을 입력해 주세요." });
  session.expectedEmail = typeof req.body.expectedEmail === "string" ? req.body.expectedEmail.trim() : undefined;
  let adapter: McpAdapter | undefined;
  try {
    adapter = await connectToNotionMcp(token);
    session.identity = await readNotionIdentity(adapter);
    const actualEmail = typeof session.identity.user?.email === "string" ? session.identity.user.email.toLowerCase() : "";
    if (session.expectedEmail && actualEmail && session.expectedEmail.toLowerCase() !== actualEmail) {
      throw new Error(`입력한 이메일과 연결 계정이 다릅니다. 현재 연결: ${actualEmail}`);
    }
    session.tokens = { access_token: token, token_type: "Bearer", kind: "pat" };
    return res.json({ connected: true, authKind: "pat", identity: publicNotionIdentity(session) });
  } catch (error) {
    session.tokens = undefined;
    next(error);
  } finally {
    await adapter?.close().catch(() => undefined);
  }
};
app.post(["/api/notion/auth/pat", "/api/auth/pat"], notionPat);

const notionLogout = (req: Request, res: Response) => {
  const rootSession = getSession(req, res);
  rootSession.notion = {};
  res.status(204).end();
};
app.post(["/api/notion/auth/logout", "/api/auth/logout"], notionLogout);

const notionExtract = async (req: Request, res: Response) => {
  const session = getSession(req, res).notion;
  const body = req.body as Partial<NotionExtractionInput>;
  const input: NotionExtractionInput = {
    target: typeof body.target === "string" ? body.target.trim() : "",
    expectedEmail: typeof body.expectedEmail === "string" ? body.expectedEmail.trim() : session.expectedEmail,
    searchQuery: typeof body.searchQuery === "string" ? body.searchQuery.trim() : undefined,
    maxRows: Math.min(50, Math.max(1, Number(body.maxRows) || 10)),
    includeArchived: body.includeArchived !== false,
    includeComments: body.includeComments !== false,
    includeTranscript: body.includeTranscript === true,
    mode: body.mode === "demo" ? "demo" : "live",
  };
  if (!input.target) return res.status(400).json({ message: "Notion URL 또는 ID를 입력해 주세요." });
  try {
    // 잘못된 링크는 MCP 호출까지 가기 전에 끊고, ID만 붙여넣은 경우는 표준 URL로 편다.
    input.target = parseNotionTarget(input.target).sourceUrl;
  } catch (error) {
    return res.status(400).json({ message: (error as Error).message });
  }
  if (input.mode === "live" && !session.tokens) return res.status(401).json({ message: "Notion 계정을 먼저 연결해 주세요." });
  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.flushHeaders();
  const runId = randomUUID();
  const write = (event: ExtractionEvent) => {
    const enriched = {
      ...event,
      provider: "notion" as const,
      runId,
      origin: event.tool ? "mcp" as const : "internal" as const,
      responseBytes: event.response === undefined ? undefined : responseBytes(event.response),
    };
    res.write(`${JSON.stringify(enriched)}\n`);
  };
  let adapter: McpAdapter | undefined;
  try {
    adapter = input.mode === "demo" ? await DemoMcpAdapter.create() : await connectToNotionMcp(await ensureNotionAccessToken(session));
    await runExtraction(adapter, input, write);
  } catch (error) {
    write({
      type: "fatal",
      id: "fatal",
      order: Number.MAX_SAFE_INTEGER,
      group: "summary",
      label: "추출 중단",
      state: "error",
      startedAt: new Date().toISOString(),
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await adapter?.close().catch(() => undefined);
    res.end();
  }
};
app.post(["/api/notion/extract/stream", "/api/extract/stream"], notionExtract);

app.get("/api/figma/status", async (req, res) => {
  const session = getSession(req, res).figma;
  const transport = req.query.transport === "remote" ? "remote" : req.query.transport === "codex" ? "codex" : req.query.transport === "plugin" ? "plugin" : "desktop";
  cleanupRuns(session.runs);
  if (transport === "codex") return res.json(await inspectCodexBridge(session.codex));
  if (transport === "plugin") {
    const plugin = figmaPluginBridge.status(getSession(req, res).id);
    return res.json({
      connected: plugin.connected,
      transport,
      beta: true,
      tools: plugin.connected ? [
        { name: "plugin_get_node_context", description: "현재 열린 파일의 링크 노드를 Plugin API로 직렬화합니다." },
        { name: "plugin_export_artifacts", description: "현재 노드의 PNG와 원본 이미지·SVG를 내보냅니다." },
        { name: "rest_get_version_history", description: "OAuth 연결 시 최근 버전의 노드를 비교합니다." },
      ] : [],
      plugin,
      restOAuth: figmaRestOAuthStatus(session.rest),
      message: plugin.connected ? "Figma Plugin Bridge가 추출 요청을 기다리고 있습니다." : "Trace Studio에서 페어링 코드를 만든 뒤 Figma 개발 플러그인에 입력해 주세요.",
    });
  }
  let adapter: McpAdapter | undefined;
  try {
    if (transport === "remote" && !session.oauth.tokens) {
      return res.json({ connected: false, transport, beta: true, message: "Figma Remote OAuth 연결이 필요합니다." });
    }
    adapter = transport === "remote"
      ? await connectToFigmaRemote(session.oauth, FIGMA_CALLBACK_URL)
      : await connectToFigmaDesktop();
    const tools = await adapter.listTools();
    let identity: unknown;
    if (transport === "remote") {
      const whoami = resolveTool(tools, "whoami");
      if (whoami) identity = parseToolResult(await adapter.callTool(whoami, {})).payload;
    }
    return res.json({ connected: true, transport, beta: transport === "remote", tools, identity });
  } catch (error) {
    return res.json({ connected: false, transport, beta: transport === "remote", message: error instanceof Error ? error.message : String(error) });
  } finally {
    await adapter?.close().catch(() => undefined);
  }
});

app.use("/api/figma/plugin", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

app.post("/api/figma/plugin/pair/start", (req, res) => {
  const session = getSession(req, res);
  res.json(figmaPluginBridge.createPairing(session.id));
});

app.get("/api/figma/plugin/status", (req, res) => {
  const session = getSession(req, res);
  res.json(figmaPluginBridge.status(session.id));
});

function parsePluginMeta(value: unknown): FigmaPluginMeta | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.editorType !== "figma" && record.editorType !== "figjam") return undefined;
  if (typeof record.pluginVersion !== "string" || !record.pluginVersion.trim()) return undefined;
  const text = (key: string, max: number) => typeof record[key] === "string" ? String(record[key]).slice(0, max) : undefined;
  const rawUser = record.user && typeof record.user === "object" ? record.user as Record<string, unknown> : undefined;
  return {
    pluginVersion: record.pluginVersion.slice(0, 40),
    editorType: record.editorType,
    fileKey: text("fileKey", 200),
    fileName: text("fileName", 300),
    pageName: text("pageName", 300),
    user: rawUser ? {
      id: typeof rawUser.id === "string" ? rawUser.id.slice(0, 200) : null,
      name: typeof rawUser.name === "string" ? rawUser.name.slice(0, 300) : undefined,
      photoUrl: typeof rawUser.photoUrl === "string" ? rawUser.photoUrl.slice(0, 2_000) : null,
    } : undefined,
  };
}

app.post("/api/figma/plugin/pair/complete", (req, res) => {
  try {
    const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
    const meta = parsePluginMeta(req.body?.meta);
    if (!/^\d{6}$/.test(code) || !meta) return res.status(400).json({ message: "6자리 코드와 올바른 플러그인 정보가 필요합니다." });
    const result = figmaPluginBridge.completePairing(code, meta, req.ip ?? "local");
    res.json(result);
  } catch (error) {
    res.status(401).json({ message: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/figma/plugin/jobs/next", async (req, res) => {
  try {
    const controller = new AbortController();
    req.once("aborted", () => controller.abort());
    const token = bearerToken(req.headers.authorization);
    if (!token) return res.status(401).json({ message: "플러그인 세션 토큰이 필요합니다." });
    const job = await figmaPluginBridge.nextJob(token, controller.signal);
    if (!job) return res.status(204).end();
    return res.json({ job });
  } catch (error) {
    return res.status(401).json({ message: error instanceof Error ? error.message : String(error) });
  }
});

app.put("/api/figma/plugin/jobs/:jobId/artifacts/:slot", express.raw({ type: "*/*", limit: "10mb" }), (req, res) => {
  try {
    const token = bearerToken(req.headers.authorization);
    const body = req.body instanceof Buffer ? new Uint8Array(req.body) : new Uint8Array();
    figmaPluginBridge.uploadArtifact(token ?? "", String(req.params.jobId), String(req.params.slot), req.headers["content-type"]?.split(";")[0] ?? "application/octet-stream", body);
    res.status(204).end();
  } catch (error) {
    res.status(400).json({ message: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/figma/plugin/jobs/:jobId/result", (req, res) => {
  try {
    const token = bearerToken(req.headers.authorization);
    if (!token) return res.status(401).json({ message: "플러그인 세션 토큰이 필요합니다." });
    if (typeof req.body?.error === "string") figmaPluginBridge.submitError(token, String(req.params.jobId), req.body.error);
    else if (req.body?.result) figmaPluginBridge.submitResult(token, String(req.params.jobId), req.body.result);
    else return res.status(400).json({ message: "플러그인 결과 또는 오류가 필요합니다." });
    return res.status(204).end();
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/figma/rest/auth/start", async (req, res, next) => {
  try {
    const session = getSession(req, res).figma.rest;
    res.json({ authUrl: await beginFigmaRestOAuth(session) });
  } catch (error) { next(error); }
});

app.get("/api/figma/rest/auth/callback", async (req, res) => {
  const session = getSession(req, res).figma.rest;
  const ticket = typeof req.query.ticket === "string" ? req.query.ticket : "";
  try {
    if (!ticket) throw new Error("OAuth broker ticket이 없습니다.");
    await finishFigmaRestOAuth(session, ticket);
    res.redirect(`${APP_ORIGIN}/figma?restAuth=connected`);
  } catch (error) {
    clearFigmaRestOAuth(session);
    res.redirect(`${APP_ORIGIN}/figma?restAuth=error&reason=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`);
  }
});

app.post("/api/figma/rest/auth/logout", (req, res) => {
  clearFigmaRestOAuth(getSession(req, res).figma.rest);
  res.status(204).end();
});

app.post("/api/figma/codex/auth/start", async (req, res, next) => {
  try {
    const session = getSession(req, res).figma;
    return res.json({ flow: await startCodexAccountLogin(session.codex) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/figma/codex/figma/start", async (req, res, next) => {
  try {
    const session = getSession(req, res).figma;
    return res.json({ flow: await startCodexFigmaLogin(session.codex) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/figma/codex/auth/cancel", (req, res) => {
  cancelCodexAuth(getSession(req, res).figma.codex);
  res.status(204).end();
});

app.post("/api/figma/auth/start", async (req, res) => {
  const session = getSession(req, res).figma;
  try {
    const authUrl = await beginFigmaRemoteOAuth(session.oauth, FIGMA_CALLBACK_URL);
    return res.json({ authUrl, beta: true });
  } catch (error) {
    return res.status(409).json({
      beta: true,
      message: `Figma Remote 연결을 시작할 수 없습니다. Desktop MCP를 사용할 수 있습니다. ${error instanceof Error ? error.message : String(error)}`,
    });
  }
});

app.get("/api/figma/auth/callback", async (req, res) => {
  const session = getSession(req, res).figma;
  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  const state = typeof req.query.state === "string" ? req.query.state : undefined;
  const oauthError = typeof req.query.error === "string" ? req.query.error : undefined;
  if (oauthError) return res.redirect(`${APP_ORIGIN}/figma?auth=error&reason=${encodeURIComponent(oauthError)}`);
  if (!code || state !== session.oauth.state) return res.redirect(`${APP_ORIGIN}/figma?auth=error&reason=invalid_callback`);
  try {
    await finishFigmaRemoteOAuth(session.oauth, FIGMA_CALLBACK_URL, code);
    return res.redirect(`${APP_ORIGIN}/figma?auth=connected`);
  } catch (error) {
    session.oauth.tokens = undefined;
    return res.redirect(`${APP_ORIGIN}/figma?auth=error&reason=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`);
  }
});

app.post("/api/figma/auth/logout", (req, res) => {
  const session = getSession(req, res).figma;
  session.oauth = createFigmaOAuthSession();
  res.status(204).end();
});

app.post("/api/figma/extract/stream", async (req, res) => {
  const rootSession = getSession(req, res);
  const session = rootSession.figma;
  const body = req.body as Partial<FigmaExtractionInput>;
  const mode = body.mode === "demo" ? "demo" : "live";
  const transport = body.transport === "remote" ? "remote" : body.transport === "codex" ? "codex" : body.transport === "plugin" ? "plugin" : "desktop";
  const targetMode = body.targetMode === "selection" ? "selection" : "link";
  const input: FigmaExtractionInput = {
    target: mode === "demo" ? FIGMA_DEMO_TARGET : typeof body.target === "string" ? body.target.trim() : "",
    targetMode: mode === "demo" ? "link" : targetMode,
    transport,
    includeVariables: body.includeVariables !== false,
    includeCodeConnect: body.includeCodeConnect !== false,
    includeMotion: body.includeMotion !== false,
    includeLibraries: body.includeLibraries === true,
    includeAssets: body.includeAssets === true,
    clientFrameworks: typeof body.clientFrameworks === "string" && body.clientFrameworks.trim() ? body.clientFrameworks.trim().slice(0, 200) : "unknown",
    clientLanguages: typeof body.clientLanguages === "string" && body.clientLanguages.trim() ? body.clientLanguages.trim().slice(0, 200) : "unknown",
    codeConnectLabel: typeof body.codeConnectLabel === "string" && body.codeConnectLabel.trim() ? body.codeConnectLabel.trim().slice(0, 100) : undefined,
    mode,
  };

  if (mode === "live" && input.targetMode === "link" && !input.target) return res.status(400).json({ message: "Figma 노드 링크를 입력해 주세요." });
  if (mode === "live" && input.targetMode === "selection" && transport !== "desktop") return res.status(400).json({ message: "현재 선택은 Desktop MCP에서만 사용할 수 있습니다." });
  if (mode === "live" && transport === "remote" && !session.oauth.tokens) return res.status(401).json({ message: "Figma Remote를 먼저 연결해 주세요." });
  if (mode === "live" && transport === "codex") {
    const status = await inspectCodexBridge(session.codex);
    if (!status.connected) return res.status(401).json({ message: status.message ?? "Codex Bridge를 먼저 연결해 주세요." });
  }
  if (mode === "live" && transport === "plugin" && !figmaPluginBridge.status(rootSession.id).connected) return res.status(401).json({ message: "Figma 플러그인을 먼저 페어링하고 열린 상태로 유지해 주세요." });

  const run = createFigmaRun(rootSession.id, input);
  addRunToSession(session.runs, run);
  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-MCP-Trace-Run", run.id);
  res.flushHeaders();
  const write = async (event: ExtractionEvent) => {
    upsertRunEvent(run, event);
    if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
  };

  let adapter: McpAdapter | undefined;
  const controller = new AbortController();
  req.once("aborted", () => controller.abort());
  try {
    if (mode === "live" && transport === "codex") {
      await runCodexFigmaExtraction(session.codex, input, run, write, controller.signal);
    } else if (mode === "live" && transport === "plugin") {
      await runPluginFigmaExtraction(figmaPluginBridge, rootSession.id, session.rest, input, run, write, controller.signal);
    } else {
      adapter = mode === "demo"
        ? new FigmaDemoAdapter()
        : transport === "remote"
          ? await connectToFigmaRemote(session.oauth, FIGMA_CALLBACK_URL)
          : await connectToFigmaDesktop();
      await runFigmaExtraction(adapter, input, run, write);
    }
  } catch (error) {
    const event: ExtractionEvent = {
      type: "fatal",
      id: "fatal",
      order: Number.MAX_SAFE_INTEGER,
      group: "summary",
      label: "Figma 추출 중단",
      state: "error",
      provider: "figma",
      runId: run.id,
      origin: "internal",
      startedAt: new Date().toISOString(),
      message: error instanceof Error ? error.message : String(error),
    };
    await write(event);
  } finally {
    run.completedAt = new Date().toISOString();
    await adapter?.close().catch(() => undefined);
    res.end();
  }
});

app.post("/api/figma/questions/stream", async (req, res) => {
  const rootSession = getSession(req, res);
  const session = rootSession.figma;
  const body = req.body as Partial<FigmaExtractionInput>;
  const transport = body.transport === "plugin" ? "plugin" : body.transport === "codex" ? "codex" : undefined;
  const question = typeof body.question === "string" ? body.question.trim().slice(0, 4_000) : "";
  const target = typeof body.target === "string" ? body.target.trim() : "";
  if (!transport) return res.status(400).json({ message: "질문은 Codex β 또는 Plugin 연결에서 사용할 수 있습니다." });
  if (!target) return res.status(400).json({ message: "Figma 노드 링크를 입력해 주세요." });
  if (!question) return res.status(400).json({ message: "노드에 대해 질문할 내용을 입력해 주세요." });
  if (transport === "codex") {
    const status = await inspectCodexBridge(session.codex);
    if (!status.connected) return res.status(401).json({ message: status.message ?? "Codex Bridge를 먼저 연결해 주세요." });
  } else if (!figmaPluginBridge.status(rootSession.id).connected) return res.status(401).json({ message: "Figma 플러그인을 먼저 페어링하고 열린 상태로 유지해 주세요." });

  const input: FigmaExtractionInput = {
    target,
    targetMode: "link",
    transport,
    includeVariables: body.includeVariables !== false,
    includeCodeConnect: body.includeCodeConnect !== false,
    includeMotion: body.includeMotion !== false,
    includeLibraries: body.includeLibraries === true,
    includeAssets: body.includeAssets !== false,
    clientFrameworks: typeof body.clientFrameworks === "string" && body.clientFrameworks.trim() ? body.clientFrameworks.trim().slice(0, 200) : "unknown",
    clientLanguages: typeof body.clientLanguages === "string" && body.clientLanguages.trim() ? body.clientLanguages.trim().slice(0, 200) : "unknown",
    codeConnectLabel: typeof body.codeConnectLabel === "string" && body.codeConnectLabel.trim() ? body.codeConnectLabel.trim().slice(0, 100) : undefined,
    question,
    mode: "live",
  };
  const run = createFigmaRun(rootSession.id, input);
  addRunToSession(session.runs, run);
  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-MCP-Trace-Run", run.id);
  res.flushHeaders();
  const write = async (event: ExtractionEvent) => {
    upsertRunEvent(run, event);
    if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
  };
  const controller = new AbortController();
  req.once("aborted", () => controller.abort());
  try {
    if (transport === "codex") await runCodexFigmaExtraction(session.codex, input, run, write, controller.signal);
    else await runPluginFigmaExtraction(figmaPluginBridge, rootSession.id, session.rest, input, run, write, controller.signal);
  } catch (error) {
    await write({
      type: "fatal",
      id: "fatal",
      order: Number.MAX_SAFE_INTEGER,
      group: "summary",
      label: "Figma 질문 중단",
      state: "error",
      provider: "figma",
      runId: run.id,
      origin: "internal",
      startedAt: new Date().toISOString(),
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    run.completedAt = new Date().toISOString();
    res.end();
  }
});

function findRun(req: Request, res: Response): FigmaRunRecord | undefined {
  const session = getSession(req, res).figma;
  cleanupRuns(session.runs);
  const run = session.runs.get(String(req.params.runId));
  if (!run) res.status(404).json({ message: "실행 기록이 만료되었거나 없습니다." });
  return run;
}

app.get("/api/figma/runs/:runId", (req, res) => {
  const run = findRun(req, res);
  if (run) res.json(serializeFigmaRun(run));
});

app.get("/api/figma/runs/:runId/bundle.zip", (req, res) => {
  const run = findRun(req, res);
  if (!run) return;
  const zip = buildFigmaRunZip(run);
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Disposition", `attachment; filename="figma-mcp-trace-${run.id}.zip"`);
  res.send(Buffer.from(zip));
});

app.get("/api/figma/runs/:runId/artifacts/:artifactId", (req, res) => {
  const run = findRun(req, res);
  if (!run) return;
  const artifact = run.artifacts.get(String(req.params.artifactId));
  if (!artifact) return res.status(404).json({ message: "artifact가 없습니다." });
  res.setHeader("Content-Type", artifact.mimeType);
  res.setHeader("Content-Length", String(artifact.bytes));
  res.setHeader("Cache-Control", "private, max-age=1800");
  res.send(Buffer.from(artifact.data));
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
if (process.env.NODE_ENV === "production" && existsSync(dist)) {
  app.use(express.static(dist));
  app.get("/{*splat}", (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : String(error);
  res.status(500).json({ message });
});

app.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`MCP Trace Studio API: http://127.0.0.1:${PORT}\n`);
});
