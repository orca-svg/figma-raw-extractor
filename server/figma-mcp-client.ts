import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpAdapter, ToolDescriptor } from "./types.js";

const DESKTOP_URL = new URL("http://127.0.0.1:3845/mcp");
const REMOTE_URL = new URL("https://mcp.figma.com/mcp");

export type FigmaOAuthSession = {
  state: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  authorizationUrl?: string;
};

class FigmaSessionOAuthProvider implements OAuthClientProvider {
  constructor(
    private readonly session: FigmaOAuthSession,
    private readonly callbackUrl: string,
  ) {}

  get redirectUrl(): string {
    return this.callbackUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "MCP Trace Studio",
      client_uri: this.callbackUrl.replace(/\/api\/figma\/auth\/callback$/, ""),
      redirect_uris: [this.callbackUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    return this.session.state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.session.clientInformation;
  }

  saveClientInformation(value: OAuthClientInformationMixed): void {
    this.session.clientInformation = value;
  }

  tokens(): OAuthTokens | undefined {
    return this.session.tokens;
  }

  saveTokens(value: OAuthTokens): void {
    this.session.tokens = value;
  }

  redirectToAuthorization(url: URL): void {
    this.session.authorizationUrl = url.toString();
  }

  saveCodeVerifier(value: string): void {
    this.session.codeVerifier = value;
  }

  codeVerifier(): string {
    if (!this.session.codeVerifier) throw new Error("Figma OAuth PKCE verifier가 없습니다.");
    return this.session.codeVerifier;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all" || scope === "tokens") this.session.tokens = undefined;
    if (scope === "all" || scope === "client") this.session.clientInformation = undefined;
    if (scope === "all" || scope === "verifier") this.session.codeVerifier = undefined;
  }
}

class FigmaMcpAdapter implements McpAdapter {
  private lastCallAt = 0;

  constructor(private readonly client: Client) {}

  async listTools(): Promise<ToolDescriptor[]> {
    const result = await this.client.listTools();
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const waitMs = Math.max(0, 180 - (Date.now() - this.lastCallAt));
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    this.lastCallAt = Date.now();
    return (await this.client.callTool({ name, arguments: args })) as CallToolResult;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

function createClient(): Client {
  return new Client({ name: "mcp-trace-studio", version: "1.0.0" }, { capabilities: {} });
}

export function createFigmaOAuthSession(): FigmaOAuthSession {
  return { state: randomBytes(32).toString("hex") };
}

export async function connectToFigmaDesktop(): Promise<McpAdapter> {
  const client = createClient();
  const transport = new StreamableHTTPClientTransport(DESKTOP_URL);
  try {
    await client.connect(transport);
    return new FigmaMcpAdapter(client);
  } catch (error) {
    await client.close().catch(() => undefined);
    throw new Error(
      `Figma Desktop MCP에 연결하지 못했습니다. Figma 앱에서 파일을 열고 Dev Mode의 MCP 서버를 켜 주세요. (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

export async function beginFigmaRemoteOAuth(session: FigmaOAuthSession, callbackUrl: string): Promise<string> {
  session.authorizationUrl = undefined;
  session.state = randomBytes(32).toString("hex");
  const client = createClient();
  const provider = new FigmaSessionOAuthProvider(session, callbackUrl);
  const transport = new StreamableHTTPClientTransport(REMOTE_URL, { authProvider: provider });
  try {
    await client.connect(transport);
    await client.close();
    throw new Error("이미 Figma Remote에 연결되어 있습니다.");
  } catch (error) {
    await client.close().catch(() => undefined);
    if (!(error instanceof UnauthorizedError) || !session.authorizationUrl) {
      throw new Error(`Figma Remote OAuth를 시작하지 못했습니다. ${error instanceof Error ? error.message : String(error)}`);
    }
    return session.authorizationUrl;
  }
}

export async function finishFigmaRemoteOAuth(session: FigmaOAuthSession, callbackUrl: string, code: string): Promise<void> {
  const provider = new FigmaSessionOAuthProvider(session, callbackUrl);
  const transport = new StreamableHTTPClientTransport(REMOTE_URL, { authProvider: provider });
  await transport.finishAuth(code);
  await transport.close().catch(() => undefined);
}

export async function connectToFigmaRemote(session: FigmaOAuthSession, callbackUrl: string): Promise<McpAdapter> {
  if (!session.tokens) throw new Error("Figma Remote 인증이 필요합니다.");
  const client = createClient();
  const provider = new FigmaSessionOAuthProvider(session, callbackUrl);
  const transport = new StreamableHTTPClientTransport(REMOTE_URL, { authProvider: provider });
  try {
    await client.connect(transport);
    return new FigmaMcpAdapter(client);
  } catch (error) {
    await client.close().catch(() => undefined);
    if (error instanceof UnauthorizedError) session.tokens = undefined;
    throw error;
  }
}
