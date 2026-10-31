/**
 * Short-lived tokens that tell the API who is signed in.
 *
 * The proxy attaches one to every /api request it forwards. The API verifies it with the
 * same API_AUTH_SECRET (backend/common/auth.py) and records the subject in the audit log.
 */
import { createHmac } from "node:crypto";

export const TOKEN_ISSUER = "energytrader-web";
export const TOKEN_AUDIENCE = "energytrader-api";
export const TOKEN_TTL_S = 60;

export interface Actor {
  id: string;
  name: string;
}

const encode = (part: object) => Buffer.from(JSON.stringify(part)).toString("base64url");

/** An HS256 JWT naming the actor, valid for TOKEN_TTL_S seconds from `now` (ms). */
export function backendToken(actor: Actor, secret: string, now: number = Date.now()): string {
  if (!secret) throw new Error("backendToken needs a secret");
  const issued = Math.floor(now / 1000);
  const signingInput = [
    encode({ alg: "HS256", typ: "JWT" }),
    encode({
      sub: actor.id,
      name: actor.name,
      iss: TOKEN_ISSUER,
      aud: TOKEN_AUDIENCE,
      iat: issued,
      exp: issued + TOKEN_TTL_S,
    }),
  ].join(".");
  const signature = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}
