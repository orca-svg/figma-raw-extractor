import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import { DemoMcpAdapter } from "./demo-adapter.js";
import { runExtraction, extractIdentity, parseToolResult, resolveTool } from "./extract.js";
import { FigmaDemoAdapter, FIGMA_DEMO_TARGET } from "./figma-demo-adapter.js";
import { runFigmaExtraction } from "./figma-extract.js";
import {
  beginFigmaRemoteOAuth,
  connectToFigmaDesktop,
  connectToFigmaRemote,
  createFigmaOAuthSession,
  finishFigmaRemoteOAuth,
  type FigmaOAuthSession,
} from "./figma-mcp-client.js";
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
  FigmaRunRecord,
  McpAdapter,
  NotionExtractionInput,
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
  runs: Map<string, FigmaRunRecord>;
};

type Session = {
  id: string;
  notion: NotionSession;
  figma: FigmaSession;
};

const sessions = new Map<string, Session>();
const app = express();
const PORT = Number(process.env.PORT ?? 8787);
const API_ORIGIN = process.env.API_ORIGIN ?? `http://127.0.0.1:${PORT}`;
const APP_ORIGIN = process.env.APP_ORIGIN ?? (process.env.NODE_ENV === "production" ? API_ORIGIN : "http://127.0.0.1:5173");
const NOTION_CALLBACK_URL = `${API_ORIGIN}/api/notion/auth/callback`;
const FIGMA_CALLBACK_URL = `${API_ORIGIN}/api/figma/auth/callback`;
const COOKIE = "mcp_trace_studio_session";

app.disable("x-powered-by");
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
    figma: { oauth: createFigmaOAuthSession(), runs: new Map() },
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
    endpoints: { notion: "https://mcp.notion.com/mcp", figmaDesktop: "http://127.0.0.1:3845/mcp", figmaRemote: "https://mcp.figma.com/mcp" },
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
  const transport = req.query.transport === "remote" ? "remote" : "desktop";
  cleanupRuns(session.runs);
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
  const transport = body.transport === "remote" ? "remote" : "desktop";
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
  try {
    adapter = mode === "demo"
      ? new FigmaDemoAdapter()
      : transport === "remote"
        ? await connectToFigmaRemote(session.oauth, FIGMA_CALLBACK_URL)
        : await connectToFigmaDesktop();
    await runFigmaExtraction(adapter, input, run, write);
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
