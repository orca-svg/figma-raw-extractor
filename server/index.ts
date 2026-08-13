import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import express, { type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import { DemoMcpAdapter } from "./demo-adapter.js";
import { runExtraction, extractIdentity, parseToolResult, resolveTool } from "./extract.js";
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
import type { ExtractionEvent, ExtractionInput, McpAdapter } from "./types.js";

type Session = {
  id: string;
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

const sessions = new Map<string, Session>();
const app = express();
const PORT = Number(process.env.PORT ?? 8787);
const API_ORIGIN = process.env.API_ORIGIN ?? `http://127.0.0.1:${PORT}`;
const APP_ORIGIN = process.env.APP_ORIGIN ?? (process.env.NODE_ENV === "production" ? API_ORIGIN : "http://127.0.0.1:5173");
const CALLBACK_URL = `${API_ORIGIN}/api/auth/callback`;
const COOKIE = "notion_mcp_trace_session";

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

function getSession(req: Request, res: Response): Session {
  const existingId = parseCookies(req)[COOKIE];
  const existing = existingId ? sessions.get(existingId) : undefined;
  if (existing) return existing;
  const session: Session = { id: randomUUID() };
  sessions.set(session.id, session);
  res.cookie(COOKIE, session.id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 12,
  });
  return session;
}

function publicIdentity(session: Session) {
  return session.identity
    ? {
        workspace: session.identity.workspace,
        user: session.identity.user,
        current_tool_access: session.identity.current_tool_access,
      }
    : undefined;
}

async function readIdentity(adapter: McpAdapter) {
  const tools = await adapter.listTools();
  const fetchTool = resolveTool(tools, "fetch");
  if (!fetchTool) throw new Error("fetch 도구가 없습니다.");
  const result = parseToolResult(await adapter.callTool(fetchTool, { id: "self" }));
  if (result.isError) throw new Error(result.text || "계정 확인에 실패했습니다.");
  return extractIdentity(result.payload);
}

async function ensureAccessToken(session: Session): Promise<string> {
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
  res.json({ ok: true, mcpEndpoint: "https://mcp.notion.com/mcp", now: new Date().toISOString() });
});

app.get("/api/status", async (req, res) => {
  const session = getSession(req, res);
  if (!session.tokens) return res.json({ connected: false });
  let adapter: McpAdapter | undefined;
  try {
    adapter = await connectToNotionMcp(await ensureAccessToken(session));
    session.identity = await readIdentity(adapter);
    return res.json({ connected: true, authKind: session.tokens.kind, identity: publicIdentity(session), expectedEmail: session.expectedEmail });
  } catch (error) {
    if (error instanceof Error && /REAUTH_REQUIRED|NOT_CONNECTED|401|unauthorized/i.test(error.message)) session.tokens = undefined;
    return res.status(401).json({ connected: false, message: error instanceof Error ? error.message : String(error) });
  } finally {
    await adapter?.close().catch(() => undefined);
  }
});

app.post("/api/auth/start", async (req, res, next) => {
  try {
    const session = getSession(req, res);
    session.expectedEmail = typeof req.body.expectedEmail === "string" ? req.body.expectedEmail.trim() : undefined;
    const metadata = await discoverOAuthMetadata();
    const credentials = await registerClient(metadata, CALLBACK_URL, APP_ORIGIN);
    const { verifier, challenge } = createPkce();
    const state = createState();
    session.oauth = { metadata, credentials, verifier, state, createdAt: Date.now() };
    const authUrl = buildAuthorizationUrl({ metadata, clientId: credentials.client_id, redirectUri: CALLBACK_URL, challenge, state });
    res.json({ authUrl });
  } catch (error) {
    next(error);
  }
});

app.get("/api/auth/callback", async (req, res) => {
  const session = getSession(req, res);
  const oauth = session.oauth;
  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  const state = typeof req.query.state === "string" ? req.query.state : undefined;
  const oauthError = typeof req.query.error === "string" ? req.query.error : undefined;
  if (oauthError) return res.redirect(`${APP_ORIGIN}/?auth=error&reason=${encodeURIComponent(oauthError)}`);
  if (!oauth || !code || state !== oauth.state || Date.now() - oauth.createdAt > 10 * 60 * 1000) {
    return res.redirect(`${APP_ORIGIN}/?auth=error&reason=invalid_callback`);
  }
  try {
    const tokens = await exchangeCode({ code, verifier: oauth.verifier, metadata: oauth.metadata, credentials: oauth.credentials, redirectUri: CALLBACK_URL });
    session.tokens = { ...tokens, expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined, kind: "oauth" };
    session.oauth = { ...oauth, verifier: "", state: "", createdAt: Date.now() };
    return res.redirect(`${APP_ORIGIN}/?auth=connected`);
  } catch (error) {
    return res.redirect(`${APP_ORIGIN}/?auth=error&reason=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`);
  }
});

app.post("/api/auth/pat", async (req, res, next) => {
  const session = getSession(req, res);
  const token = typeof req.body.token === "string" ? req.body.token.trim() : "";
  if (!token) return res.status(400).json({ message: "개인 토큰을 입력해 주세요." });
  session.expectedEmail = typeof req.body.expectedEmail === "string" ? req.body.expectedEmail.trim() : undefined;
  let adapter: McpAdapter | undefined;
  try {
    adapter = await connectToNotionMcp(token);
    session.identity = await readIdentity(adapter);
    const actualEmail = typeof session.identity.user?.email === "string" ? session.identity.user.email.toLowerCase() : "";
    if (session.expectedEmail && actualEmail && session.expectedEmail.toLowerCase() !== actualEmail) {
      throw new Error(`입력한 이메일과 연결 계정이 다릅니다. 현재 연결: ${actualEmail}`);
    }
    session.tokens = { access_token: token, token_type: "Bearer", kind: "pat" };
    return res.json({ connected: true, authKind: "pat", identity: publicIdentity(session) });
  } catch (error) {
    session.tokens = undefined;
    next(error);
  } finally {
    await adapter?.close().catch(() => undefined);
  }
});

app.post("/api/auth/logout", (req, res) => {
  const session = getSession(req, res);
  sessions.delete(session.id);
  res.clearCookie(COOKIE);
  res.status(204).end();
});

app.post("/api/extract/stream", async (req, res) => {
  const session = getSession(req, res);
  const body = req.body as Partial<ExtractionInput>;
  const input: ExtractionInput = {
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
  const write = (event: ExtractionEvent) => {
    res.write(`${JSON.stringify(event)}\n`);
  };
  let adapter: McpAdapter | undefined;
  try {
    adapter = input.mode === "demo"
      ? await DemoMcpAdapter.create()
      : await connectToNotionMcp(await ensureAccessToken(session));
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
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
if (process.env.NODE_ENV === "production" && existsSync(dist)) {
  app.use(express.static(dist));
  app.get("/{*splat}", (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

app.use((error: unknown, _req: Request, res: Response, _next: (error?: unknown) => void) => {
  const message = error instanceof Error ? error.message : String(error);
  res.status(500).json({ message });
});

app.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`Notion MCP Trace API: http://127.0.0.1:${PORT}\n`);
});
