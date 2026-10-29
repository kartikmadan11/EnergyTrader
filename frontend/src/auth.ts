/**
 * Sign-in with Auth.js. See docs/AUTH.md for provider setup and deployment on Vercel.
 *
 * - Sign in with Vercel (OpenID Connect) when AUTH_VERCEL_ID and AUTH_VERCEL_SECRET are set.
 * - GitHub when AUTH_GITHUB_ID and AUTH_GITHUB_SECRET are set.
 * - In `next dev` only, a name-only local sign-in so the app runs without an OAuth app.
 *
 * OAuth accounts must be listed in AUTH_ALLOWED_USERS ("*" admits any account).
 * Sessions are stateless JWTs in an encrypted cookie; there is no user database.
 */
import NextAuth, { type DefaultSession, type Profile, type User } from "next-auth";
import type { OIDCConfig } from "next-auth/providers";
import Credentials from "next-auth/providers/credentials";
import GitHub from "next-auth/providers/github";
import { actorId, isAllowed, localUser } from "@/lib/access";

declare module "next-auth" {
  interface Session {
    user: { id: string } & DefaultSession["user"];
  }
}

const DEVELOPMENT = process.env.NODE_ENV === "development";

interface VercelProfile extends Record<string, unknown> {
  sub: string;
  name?: string;
  preferred_username?: string;
  email?: string;
  picture?: string;
}

// Vercel publishes OpenID Connect discovery at https://vercel.com/.well-known/openid-configuration.
// The client id and secret come from AUTH_VERCEL_ID and AUTH_VERCEL_SECRET.
const vercel: OIDCConfig<VercelProfile> = {
  id: "vercel",
  name: "Vercel",
  type: "oidc",
  issuer: "https://vercel.com",
  authorization: { params: { scope: "openid email profile" } },
  checks: ["pkce", "state", "nonce"],
  profile: (p) => ({
    id: p.sub,
    name: p.name ?? p.preferred_username ?? null,
    email: p.email ?? null,
    image: p.picture ?? null,
  }),
};

const local = Credentials({
  id: "local",
  name: "Local",
  credentials: { name: { label: "Display name" } },
  authorize: (credentials) => {
    const user = localUser(credentials?.name);
    return user && { id: user.handle, name: user.name };
  },
});

/** OAuth providers with credentials configured, in the order the sign-in page shows them. */
export const oauthProviders = [
  ...(process.env.AUTH_VERCEL_ID ? [{ id: "vercel", name: "Vercel" }] : []),
  ...(process.env.AUTH_GITHUB_ID ? [{ id: "github", name: "GitHub" }] : []),
] as const satisfies readonly { id: string; name: string }[];

/** Whether the development-only local sign-in is available. */
export const localSignIn = DEVELOPMENT;

/** The audited id for a sign-in, from the field each provider uses as a username. */
function actorFor(provider: string, profile: Profile | undefined, user: User): string {
  const handle =
    provider === "github"
      ? profile?.login
      : provider === "vercel"
        ? (profile?.preferred_username ?? profile?.sub)
        : user.id;
  if (typeof handle !== "string" || !handle) {
    throw new Error(`The ${provider} profile has no username to sign in with`);
  }
  return actorId(provider, handle);
}

if (DEVELOPMENT && !process.env.AUTH_SECRET) {
  console.warn("AUTH_SECRET is not set; sessions use a development-only secret.");
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    ...(process.env.AUTH_VERCEL_ID ? [vercel] : []),
    ...(process.env.AUTH_GITHUB_ID ? [GitHub] : []),
    ...(DEVELOPMENT ? [local] : []),
  ],
  // Auth.js refuses to start without a secret; production must set AUTH_SECRET.
  secret: DEVELOPMENT && !process.env.AUTH_SECRET ? "development-only-secret" : undefined,
  session: { strategy: "jwt", maxAge: 12 * 60 * 60, updateAge: 60 * 60 },
  pages: { signIn: "/login", error: "/login" },
  callbacks: {
    signIn({ account, profile, user }) {
      if (!account) return false;
      // Only registered in development.
      if (account.provider === "local") return true;
      const id = actorFor(account.provider, profile, user);
      if (isAllowed(id, process.env.AUTH_ALLOWED_USERS)) return true;
      console.info(`Sign-in refused for ${id}: not in AUTH_ALLOWED_USERS`);
      return `/login?error=AccessDenied&account=${encodeURIComponent(id)}`;
    },
    jwt({ token, account, profile, user }) {
      if (account) token.actorId = actorFor(account.provider, profile, user);
      return token;
    },
    session({ session, token }) {
      if (typeof token.actorId === "string") session.user.id = token.actorId;
      return session;
    },
  },
});
