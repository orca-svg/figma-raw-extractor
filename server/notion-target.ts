import type { NotionTarget } from "./types.js";

const HEX32 = /^[0-9a-f]{32}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 32자리 hex를 8-4-4-4-12 UUID로 편다. Notion API는 양쪽 다 받는다. */
function toUuid(hex: string): string {
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

/** 경로 세그먼트 끝에 붙은 ID를 뽑는다. "Some-Title-<32hex>" 또는 ID 단독. */
function idFromSegment(segment: string | undefined): string | undefined {
  if (!segment) return undefined;
  const decoded = decodeURIComponent(segment);
  if (UUID.test(decoded)) return decoded.toLowerCase();
  if (HEX32.test(decoded)) return toUuid(decoded.toLowerCase());
  const tail = decoded.split("-").pop();
  return tail && HEX32.test(tail) ? toUuid(tail.toLowerCase()) : undefined;
}

export function parseNotionTarget(value: string): NotionTarget {
  const raw = value.trim();
  if (!raw) throw new Error("Notion URL 또는 ID를 입력해 주세요.");

  // ID만 붙여넣은 경우도 받아준다.
  if (!raw.includes("/")) {
    const bare = idFromSegment(raw);
    if (!bare) throw new Error("Notion 페이지 링크 또는 32자리 ID를 입력해 주세요.");
    return { kind: "page", pageId: bare, sourceUrl: `https://www.notion.so/${bare.replace(/-/g, "")}` };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Notion 페이지 링크 형식을 확인해 주세요.");
  }

  if (!/(^|\.)notion\.(so|site|com)$/i.test(url.hostname)) {
    throw new Error("notion.so 또는 notion.site 링크만 사용할 수 있습니다.");
  }

  // 워크스페이스 세그먼트가 앞에 붙는 형태가 많아 뒤에서부터 훑는다.
  const segments = url.pathname.split("/").filter(Boolean);
  let pageId: string | undefined;
  for (let i = segments.length - 1; i >= 0 && !pageId; i--) pageId = idFromSegment(segments[i]);
  if (!pageId) {
    throw new Error('링크에서 Notion 페이지 ID를 찾지 못했습니다. 페이지 우상단 ⋯ → "링크 복사"로 얻은 주소를 넣어 주세요.');
  }

  const viewId = idFromSegment(url.searchParams.get("v") ?? undefined);

  return { kind: viewId ? "database" : "page", pageId, viewId, sourceUrl: url.toString() };
}
