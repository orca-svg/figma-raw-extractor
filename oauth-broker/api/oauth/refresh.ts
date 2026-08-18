import { allowPost, figmaTokenRequest, requiredEnv, sendError } from "../../lib/http.js";
import { openTicket, sealTicket, verifyRedeemSecret } from "../../lib/tickets.js";
import type { BrokerRequest, BrokerResponse } from "../../lib/vercel-types.js";

export default async function handler(req: BrokerRequest, res: BrokerResponse) {
  if (!allowPost(req, res)) return;
  try {
    const refreshGrant = typeof req.body?.refreshGrant === "string" ? req.body.refreshGrant : "";
    const redeemSecret = typeof req.body?.redeemSecret === "string" ? req.body.redeemSecret : "";
    const secret = requiredEnv("BROKER_TICKET_SECRET");
    const grant = openTicket(refreshGrant, secret, "refresh");
    if (!verifyRedeemSecret(redeemSecret, grant.redeemSecretHash)) throw new Error("OAuth refresh secret이 일치하지 않습니다.");
    const token = await figmaTokenRequest("refresh", new URLSearchParams({ refresh_token: grant.refreshToken }));
    const accessToken = typeof token.access_token === "string" ? token.access_token : "";
    if (!accessToken) throw new Error("Figma OAuth refresh 응답에 access token이 없습니다.");
    const nextRefreshToken = typeof token.refresh_token === "string" ? token.refresh_token : grant.refreshToken;
    const nextGrant = sealTicket({ ...grant, refreshToken: nextRefreshToken, createdAt: Date.now(), expiresAt: Date.now() + 90 * 24 * 60 * 60 * 1000 }, secret);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ accessToken, expiresIn: typeof token.expires_in === "number" ? token.expires_in : 7_776_000, refreshGrant: nextGrant, userId: grant.userId });
  } catch (error) {
    sendError(res, error);
  }
}
