export function figmaPreviewUrls(value: unknown): string[] {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); } catch { return []; }
  if (typeof serialized !== "string") return [];
  const matches = serialized.match(/https:\/\/[^\s"'<>\\]+/g) ?? [];
  const urls: string[] = [];
  for (const raw of matches) {
    try {
      const normalized = raw.replace(/\\n.*$/, "").replace(/[),.;\\]+$/, "");
      const url = new URL(normalized);
      if (url.protocol !== "https:" || !(url.hostname === "figma.com" || url.hostname.endsWith(".figma.com"))) continue;
      if (!/\/api\/mcp\/asset\//.test(url.pathname) || !/\.(?:png|jpe?g|webp|gif|svg)$/i.test(url.pathname)) continue;
      if (!urls.includes(url.href)) urls.push(url.href);
    } catch {
      // Ignore malformed URLs embedded in arbitrary Tool text.
    }
  }
  return urls.slice(0, 20);
}
