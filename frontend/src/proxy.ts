/**
 * Runs before every page and API request (see `config.matcher`).
 *
 * - "/" and "/login" are public. A signed-in visitor to "/login" goes straight to the app.
 * - Every other page needs a session and otherwise redirects to "/login".
 * - /api requests need a session too. The client's own Authorization header is dropped and
 *   replaced with a short-lived token naming the user, which the API verifies.
 *
 * The (app) layout checks the session again, so a page is never served on the strength of
 * this file alone.
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { HOME_PATH, SIGNED_OUT, safeCallbackPath } from "@/lib/access";
import { backendToken } from "@/lib/backend-token";

const PUBLIC_PAGES = new Set(["/", "/login"]);
const API_AUTH_SECRET = process.env.API_AUTH_SECRET ?? "";
const PRODUCTION = process.env.NODE_ENV === "production";

export default auth((req) => {
  const { pathname, search } = req.nextUrl;
  const user = req.auth?.user;
  const signedIn = Boolean(user?.id);

  if (pathname.startsWith("/api/")) {
    if (!user?.id) {
      return NextResponse.json(
        { detail: "Your session has ended. Sign in again.", reason: SIGNED_OUT },
        { status: 401 },
      );
    }
    // The API needs only the token, not the browser's session cookie.
    const headers = new Headers(req.headers);
    headers.delete("authorization");
    headers.delete("cookie");
    if (API_AUTH_SECRET) {
      const actor = { id: user.id, name: user.name || user.id };
      headers.set("authorization", `Bearer ${backendToken(actor, API_AUTH_SECRET)}`);
    } else if (PRODUCTION) {
      console.error("API_AUTH_SECRET is not set; refusing to call the API without a token.");
      return NextResponse.json(
        { detail: "The web app is missing API_AUTH_SECRET." },
        { status: 500 },
      );
    }
    return NextResponse.next({ request: { headers } });
  }

  if (pathname === "/login") {
    if (signedIn) {
      const target = safeCallbackPath(req.nextUrl.searchParams.get("callbackUrl"));
      return NextResponse.redirect(new URL(target, req.nextUrl));
    }
    return NextResponse.next();
  }

  if (PUBLIC_PAGES.has(pathname) || signedIn) return NextResponse.next();

  const login = new URL("/login", req.nextUrl);
  const back = `${pathname}${search}`;
  if (back !== HOME_PATH) login.searchParams.set("callbackUrl", back);
  return NextResponse.redirect(login);
});

export const config = {
  // Everything except Auth.js's own routes, build assets and the site icons.
  matcher: ["/((?!api/auth/|_next/static/|_next/image|(?:favicon\\.ico|icon\\.svg)$).*)"],
};
