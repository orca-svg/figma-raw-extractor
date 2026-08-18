import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpAdapter, ToolDescriptor } from "./types.js";

export const FIGMA_DEMO_TARGET = "https://www.figma.com/design/DemoTraceStudio/MCP-Trace-Studio?node-id=120-48";

const DEMO_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="620" viewBox="0 0 960 620">
  <rect width="960" height="620" rx="36" fill="#EEF0F5"/>
  <rect x="72" y="64" width="816" height="492" rx="28" fill="#FCFCFD" stroke="#D5D8E2"/>
  <rect x="112" y="108" width="218" height="404" rx="20" fill="#171A22"/>
  <circle cx="151" cy="148" r="13" fill="#6E57D2"/>
  <rect x="178" y="137" width="104" height="12" rx="6" fill="#FCFCFD" opacity=".9"/>
  <rect x="178" y="158" width="72" height="8" rx="4" fill="#FCFCFD" opacity=".36"/>
  <rect x="370" y="108" width="478" height="126" rx="20" fill="#6E57D2"/>
  <rect x="408" y="146" width="250" height="20" rx="10" fill="#FCFCFD"/>
  <rect x="408" y="179" width="170" height="10" rx="5" fill="#FCFCFD" opacity=".55"/>
  <rect x="370" y="260" width="228" height="252" rx="20" fill="#FFFFFF" stroke="#D5D8E2"/>
  <rect x="620" y="260" width="228" height="252" rx="20" fill="#FFFFFF" stroke="#D5D8E2"/>
  <rect x="398" y="294" width="172" height="104" rx="14" fill="#E8E3FF"/>
  <rect x="648" y="294" width="172" height="104" rx="14" fill="#FCE7E3"/>
  <rect x="398" y="430" width="130" height="12" rx="6" fill="#171A22" opacity=".82"/>
  <rect x="398" y="455" width="96" height="9" rx="4.5" fill="#171A22" opacity=".28"/>
  <rect x="648" y="430" width="130" height="12" rx="6" fill="#171A22" opacity=".82"/>
  <rect x="648" y="455" width="96" height="9" rx="4.5" fill="#171A22" opacity=".28"/>
</svg>`;

function textResult(value: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    isError,
  };
}

function screenshotResult(): CallToolResult {
  return {
    content: [{ type: "image", data: Buffer.from(DEMO_SVG).toString("base64"), mimeType: "image/svg+xml" }],
  };
}

export class FigmaDemoAdapter implements McpAdapter {
  async listTools(): Promise<ToolDescriptor[]> {
    return [
      "get_design_context",
      "get_metadata",
      "get_screenshot",
      "get_variable_defs",
      "get_code_connect_map",
      "get_motion_context",
      "get_libraries",
      "download_assets",
    ].map((name) => ({ name, inputSchema: { type: "object" } }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    await new Promise((resolve) => setTimeout(resolve, 120));
    if (name === "get_design_context") {
      return textResult({
        code: `<section className="studio-shell">\n  <TraceSidebar />\n  <main><ModeShuttle /><ToolTimeline /></main>\n  <RawInspector />\n</section>`,
        metadata: {
          nodeId: args.nodeId,
          name: "MCP Trace Studio / Figma Inspector",
          width: 1440,
          height: 960,
          layoutMode: "HORIZONTAL",
          components: ["ModeShuttle", "ToolTimeline", "RawInspector"],
        },
        assets: [],
      });
    }
    if (name === "get_metadata") {
      return textResult(`<frame id="120:48" name="Figma Inspector" x="0" y="0" width="1440" height="960"><frame id="120:51" name="Tool timeline" x="360" y="220" width="620" height="680"/><frame id="120:52" name="Raw inspector" x="1000" y="220" width="400" height="680"/></frame>`);
    }
    if (name === "get_screenshot") return screenshotResult();
    if (name === "get_variable_defs") {
      return textResult({
        "Studio/Fog": "#EEF0F5",
        "Surface/Primary": "#FCFCFD",
        "Ink/Graphite": "#171A22",
        "Provider/Figma": "#6E57D2",
        "Space/Panel": 18,
        "Radius/Layer": 20,
      });
    }
    if (name === "get_code_connect_map") {
      return textResult({
        "120:61": { componentName: "ModeShuttle", source: "src/components/ModeShuttle.tsx", label: "React" },
        "120:72": { componentName: "ToolTimeline", source: "src/components/ExtractionTimeline.tsx", label: "React" },
      });
    }
    if (name === "get_motion_context") {
      return textResult({
        animatedNodes: ["120:61"],
        tracks: [{ property: "transform.x", response: 0.38, dampingRatio: 1, overshoot: false }],
        coordination: "Mode content follows the provider shuttle without input lockout.",
      });
    }
    if (name === "get_libraries") return textResult({ subscribed: [{ name: "Trace Studio Components", key: "demo-library" }], available: [] });
    if (name === "download_assets") return screenshotResult();
    return textResult({ code: "tool_not_found", message: `${name}은 Figma 예제에 없습니다.` }, true);
  }

  async close(): Promise<void> {
    // No remote resources in demo mode.
  }
}
