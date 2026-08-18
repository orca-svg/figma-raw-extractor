import { allowPost, requiredEnv, sendError } from "../../lib/http.js";
import { openTicket, sealTicket, verifyRedeemSecret } from "../../lib/tickets.js";
import type { BrokerRequest, BrokerResponse } from "../../lib/vercel-types.js";

export default function handler(req: BrokerRequest, res: BrokerResponse) {
  if (!allowPost(req, res)) return;
  try {
    const ticket = typeof req.body?.ticket === "string" ? req.body.ticket : "";
    const redeemSecret = typeof req.body?.redeemSecret === "string" ? req.body.redeemSecret : "";
    const secret = requiredEnv("BROKER_TICKET_SECRET");
    const result = openTicket(ticket, secret, "result");
    if (!verifyRedeemSecret(redeemSecret, result.redeemSecretHash)) throw new Error("OAuth redeem secret이 일치하지 않습니다.");
    const refreshGrant = result.refreshToken ? sealTicket({
      type: "refresh",
      refreshToken: result.refreshToken,
      userId: result.userId,
      redeemSecretHash: result.redeemSecretHash,
      createdAt: Date.now(),
      expiresAt: Date.now() + 90 * 24 * 60 * 60 * 1000,
    }, secret) : undefined;
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ accessToken: result.accessToken, expiresIn: result.expiresIn, refreshGrant, userId: result.userId });
  } catch (error) {
    sendError(res, error);
  }
}
