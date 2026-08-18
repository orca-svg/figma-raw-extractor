import type { BrokerRequest, BrokerResponse } from "./vercel-types.js";

export function allowPost(req: BrokerRequest, res: BrokerResponse): boolean {
  if (req.method === "POST") return true;
  res.setHeader("Allow", "POST");
  res.status(405).json({ message: "POST 요청만 허용됩니다." });
  return false;
}

export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} 환경 변수가 필요합니다.`);
  return value;
}

export function brokerOrigin(req: BrokerRequest): string {
  const configured = process.env.BROKER_PUBLIC_ORIGIN?.trim().replace(/\/$/, "");
  if (configured) return configured;
  const host = req.headers["x-forwarded-host"] ?? req.headers.host;
  if (!host) throw new Error("브로커 공개 주소를 확인하지 못했습니다.");
  return `https://${Array.isArray(host) ? host[0] : host}`;
}

export function localCallbackOrigin(): string {
  const origin = requiredEnv("LOCAL_CALLBACK_ORIGIN").replace(/\/$/, "");
  if (!/^http:\/\/127\.0\.0\.1(?::\d+)?$/.test(origin)) throw new Error("LOCAL_CALLBACK_ORIGIN은 127.0.0.1 주소여야 합니다.");
  return origin;
}

export function sendError(res: BrokerResponse, error: unknown, status = 400): void {
  const message = error instanceof Error ? error.message : String(error);
  res.status(status).json({ message });
}

export async function figmaTokenRequest(path: "token" | "refresh", body: URLSearchParams) {
  const id = requiredEnv("FIGMA_REST_CLIENT_ID");
  const secret = requiredEnv("FIGMA_REST_CLIENT_SECRET");
  const response = await fetch(`https://api.figma.com/v1/oauth/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let payload: Record<string, unknown>;
  try { payload = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { payload = { message: text }; }
  if (!response.ok) throw new Error(String(payload.message ?? payload.error_description ?? payload.error ?? `Figma OAuth 실패 (${response.status})`));
  return payload;
}
