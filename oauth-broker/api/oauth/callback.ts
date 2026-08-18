import { brokerOrigin, figmaTokenRequest, localCallbackOrigin, requiredEnv, sendError } from "../../lib/http.js";
import { openTicket, sealTicket } from "../../lib/tickets.js";
import type { BrokerRequest, BrokerResponse } from "../../lib/vercel-types.js";

export default async function handler(req: BrokerRequest, res: BrokerResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).send("GET only");
  }
  try {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (!code || !state) throw new Error("Figma OAuth callback 값이 없습니다.");
    const secret = requiredEnv("BROKER_TICKET_SECRET");
    const flow = openTicket(state, secret, "flow");
    const redirectUri = `${brokerOrigin(req)}/api/oauth/callback`;
    const token = await figmaTokenRequest("token", new URLSearchParams({
      redirect_uri: redirectUri,
      code,
      grant_type: "authorization_code",
      code_verifier: flow.codeVerifier,
    }));
    const accessToken = typeof token.access_token === "string" ? token.access_token : "";
    if (!accessToken) throw new Error("Figma OAuth access token이 없습니다.");
    const now = Date.now();
    const ticket = sealTicket({
      type: "result",
      accessToken,
      expiresIn: typeof token.expires_in === "number" ? token.expires_in : 7_776_000,
      refreshToken: typeof token.refresh_token === "string" ? token.refresh_token : undefined,
      userId: typeof token.user_id_string === "string" ? token.user_id_string : undefined,
      redeemSecretHash: flow.redeemSecretHash,
      createdAt: now,
      expiresAt: now + 60 * 1000,
    }, secret);
    const localOrigin = localCallbackOrigin();
    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, `${localOrigin}/api/figma/rest/auth/callback?ticket=${encodeURIComponent(ticket)}`);
  } catch (error) {
    sendError(res, error);
  }
}
