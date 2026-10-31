/** Who may sign in, what they are called in the audit trail, and where they land afterwards. */

export const HOME_PATH = "/workstation";
/** The `reason` of the proxy's 401, so the browser can tell it from a 401 the API returned. */
export const SIGNED_OUT = "signed_out";
const LOGIN_PATH = "/login";
const MAX_HANDLE = 40;
const MAX_DISPLAY_NAME = 60;

/** Provider-qualified, lower-case user id, such as "github:octocat". The API audits by it. */
export function actorId(provider: string, handle: string): string {
  return `${provider}:${handle.trim().toLowerCase()}`;
}

/**
 * Whether an actor id may sign in, given AUTH_ALLOWED_USERS: a comma-separated list of ids,
 * "provider:*" for any account that provider authenticates, or "*" for any account at all.
 * An empty list admits nobody.
 */
export function isAllowed(id: string, allowlist: string | undefined): boolean {
  const entries = (allowlist ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const actor = id.toLowerCase();
  const provider = actor.slice(0, actor.indexOf(":") + 1);
  return (
    entries.includes("*") ||
    entries.includes(actor) ||
    (provider !== "" && entries.includes(`${provider}*`))
  );
}

/** How long a session lasts from sign-in, however active it stays: one trading day. */
export const SESSION_MAX_AGE_S = 12 * 60 * 60;

/** What the session cookie records about a sign-in. */
export interface SessionClaims {
  actorId?: unknown;
  /** Unix seconds. */
  signedInAt?: unknown;
}

/**
 * Whether a session may continue. It ends SESSION_MAX_AGE_S after sign-in, and as soon as its
 * account is no longer admitted by the allowlist, so removing someone takes effect on their
 * next request rather than when their cookie expires. Local sessions only count in development.
 */
export function sessionIsCurrent(
  claims: SessionClaims,
  allowlist: string | undefined,
  { nowS, development }: { nowS: number; development: boolean },
): boolean {
  const { actorId: id, signedInAt } = claims;
  if (typeof id !== "string" || typeof signedInAt !== "number") return false;
  if (nowS - signedInAt >= SESSION_MAX_AGE_S || signedInAt > nowS + 60) return false;
  if (id.startsWith("local:")) return development;
  return isAllowed(id, allowlist);
}

/**
 * A same-origin path to return to after signing in. Anything else, including absolute URLs
 * to other hosts and protocol-relative "//host" paths, falls back to the Workstation.
 */
export function safeCallbackPath(raw: string | string[] | null | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return HOME_PATH;
  }
  const base = "http://callback.invalid";
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return HOME_PATH;
  }
  if (url.origin !== base || url.pathname === LOGIN_PATH) return HOME_PATH;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The display name and handle for a development sign-in, or null if the name has neither. */
export function localUser(rawName: unknown): { handle: string; name: string } | null {
  const name = String(rawName ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DISPLAY_NAME);
  const handle = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_HANDLE)
    .replace(/-+$/, "");
  return handle ? { handle, name } : null;
}
