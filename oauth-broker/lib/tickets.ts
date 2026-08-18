import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type FlowTicketPayload = {
  type: "flow";
  codeVerifier: string;
  redeemSecretHash: string;
  createdAt: number;
  expiresAt: number;
};

export type ResultTicketPayload = {
  type: "result";
  accessToken: string;
  expiresIn: number;
  refreshToken?: string;
  userId?: string;
  redeemSecretHash: string;
  createdAt: number;
  expiresAt: number;
};

export type RefreshGrantPayload = {
  type: "refresh";
  refreshToken: string;
  userId?: string;
  redeemSecretHash: string;
  createdAt: number;
  expiresAt: number;
};

type TicketPayload = FlowTicketPayload | ResultTicketPayload | RefreshGrantPayload;

function keyFromSecret(secret: string): Buffer {
  if (secret.length < 32) throw new Error("BROKER_TICKET_SECRET은 32자 이상이어야 합니다.");
  return createHash("sha256").update(secret).digest();
}

export function sealTicket(payload: TicketPayload, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFromSecret(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((part) => part.toString("base64url")).join(".");
}

export function openTicket<T extends TicketPayload["type"]>(token: string, secret: string, type: T): Extract<TicketPayload, { type: T }> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("OAuth 티켓 형식이 잘못되었습니다.");
  try {
    const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", keyFromSecret(secret), iv);
    decipher.setAuthTag(tag);
    const payload = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")) as TicketPayload;
    if (payload.type !== type) throw new Error("OAuth 티켓 종류가 다릅니다.");
    if (!Number.isFinite(payload.expiresAt) || payload.expiresAt <= Date.now()) throw new Error("OAuth 티켓이 만료되었습니다.");
    return payload as Extract<TicketPayload, { type: T }>;
  } catch (error) {
    if (error instanceof Error && /종류|만료/.test(error.message)) throw error;
    throw new Error("OAuth 티켓을 검증하지 못했습니다.");
  }
}

export function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function verifyRedeemSecret(value: string, expectedHash: string): boolean {
  const actual = Buffer.from(sha256Base64Url(value));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
