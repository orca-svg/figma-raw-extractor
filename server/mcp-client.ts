import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpAdapter, ToolDescriptor } from "./types.js";

const MCP_URL = new URL("https://mcp.notion.com/mcp");
const SSE_URL = new URL("https://mcp.notion.com/sse");
const USER_AGENT = "Notion-MCP-Trace-Lab/1.0";

class RemoteMcpAdapter implements McpAdapter {
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
    const waitMs = Math.max(0, 350 - (Date.now() - this.lastCallAt));
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    this.lastCallAt = Date.now();
    return (await this.client.callTool({ name, arguments: args })) as CallToolResult;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

async function connectWithTransport(accessToken: string, useSse: boolean): Promise<McpAdapter> {
  const client = new Client(
    { name: "notion-mcp-trace-lab", version: "1.0.0" },
    { capabilities: {} },
  );
  const requestInit: RequestInit = {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": USER_AGENT,
    },
  };
  const transport = useSse
    ? new SSEClientTransport(SSE_URL, { requestInit })
    : new StreamableHTTPClientTransport(MCP_URL, { requestInit });
  await client.connect(transport);
  return new RemoteMcpAdapter(client);
}

export async function connectToNotionMcp(accessToken: string): Promise<McpAdapter> {
  try {
    return await connectWithTransport(accessToken, false);
  } catch (streamError) {
    try {
      return await connectWithTransport(accessToken, true);
    } catch (sseError) {
      throw new AggregateError([streamError, sseError], "Notion MCP 연결에 실패했습니다.");
    }
  }
}
