import type { FigmaTarget } from "./types.js";

function normalizeNodeId(value: string): string {
  const decoded = decodeURIComponent(value).trim();
  const dashed = decoded.match(/^(\d+)-(\d+)$/);
  return dashed ? `${dashed[1]}:${dashed[2]}` : decoded;
}

export function parseFigmaTarget(value: string): FigmaTarget {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Figma 프레임 또는 레이어 링크를 입력해 주세요.");
  }

  if (!/(^|\.)figma\.com$/i.test(url.hostname)) {
    throw new Error("figma.com의 Design 또는 FigJam 링크만 사용할 수 있습니다.");
  }

  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const root = parts[0];
  if (root !== "design" && root !== "board") {
    if (root === "slides" || root === "make") throw new Error("Figma Slides와 Make는 이 버전에서 지원하지 않습니다.");
    throw new Error("Figma Design(/design/) 또는 FigJam(/board/) 링크를 입력해 주세요.");
  }

  const baseFileKey = parts[1];
  if (!baseFileKey) throw new Error("Figma 링크에서 file key를 찾지 못했습니다.");
  const branchIndex = root === "design" ? parts.indexOf("branch") : -1;
  const fileKey = branchIndex === 2 && parts[3] ? parts[3] : baseFileKey;
  const rawNodeId = url.searchParams.get("node-id");
  if (!rawNodeId) throw new Error("파일 전체 링크가 아닌 프레임 또는 레이어 링크를 복사해 주세요. node-id가 필요합니다.");
  const nodeId = normalizeNodeId(rawNodeId);
  if (!/^\d+[:\-]\d+$/.test(nodeId)) throw new Error("Figma 링크의 node-id 형식을 확인해 주세요.");

  return {
    fileKey,
    nodeId,
    fileType: root === "design" ? "design" : "figjam",
    sourceUrl: url.toString(),
  };
}
