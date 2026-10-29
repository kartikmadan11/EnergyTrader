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
 * or "*" for any account the provider authenticates. An empty list admits nobody.
 */
export function isAllowed(id: string, allowlist: string | undefined): boolean {
  const entries = (allowlist ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return entries.includes("*") || entries.includes(id.toLowerCase());
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
