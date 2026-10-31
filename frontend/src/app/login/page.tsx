import type { Metadata } from "next";
import Link from "next/link";
import { localSignIn, oauthProviders } from "@/auth";
import BrandMark from "@/components/BrandMark";
import PriceCurve from "@/components/PriceCurve";
import { safeCallbackPath } from "@/lib/access";
import { signInLocally, signInWithProvider } from "./actions";

export const metadata: Metadata = { title: "Sign in" };

// Only echo values shaped like an actor id, so a crafted link cannot put arbitrary text here.
const ACTOR_ID = /^[a-z]+:[a-z0-9._-]{1,64}$/;

function errorMessage(error: string | undefined, account: string | undefined): string | null {
  switch (error) {
    case undefined:
      return null;
    case "AccessDenied":
      return account && ACTOR_ID.test(account)
        ? `${account} is not an approved account. Ask the administrator to add it to AUTH_ALLOWED_USERS.`
        : "This account is not approved for EnergyTrader.";
    case "CredentialsSignin":
      return "Enter a display name with at least one letter or number.";
    case "Configuration":
      return "Sign-in is not set up correctly on the server. The server log has the details.";
    default:
      return "Sign-in did not complete. Try again.";
  }
}

function VercelMark() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" aria-hidden>
      <path d="M12 2.5 23 21.5H1Z" fill="currentColor" />
    </svg>
  );
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden>
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
      />
    </svg>
  );
}

const providerStyle: Record<string, { className: string; mark: React.ReactNode }> = {
  vercel: {
    className: "bg-black text-white hover:bg-gray-800",
    mark: <VercelMark />,
  },
  github: {
    className: "border border-gray-300 bg-white text-gray-900 hover:bg-gray-50",
    mark: <GitHubMark />,
  },
};

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const query = await searchParams;
  const callbackUrl = safeCallbackPath(query.callbackUrl);
  const message = errorMessage(first(query.error), first(query.account));
  const names = oauthProviders.map((p) => p.name).join(" or ");

  return (
    <div className="flex min-h-screen bg-white">
      <aside className="relative hidden w-[46%] max-w-[680px] flex-col justify-between overflow-hidden bg-[#07111D] p-10 text-white lg:flex">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_50%_at_20%_0%,rgba(0,109,174,0.3),transparent)]" />
        <Link href="/" className="relative flex items-center gap-2.5 text-[15px] font-semibold tracking-tight">
          <BrandMark className="h-6 w-6" />
          EnergyTrader
        </Link>
        <div className="relative">
          <p className="max-w-md text-[28px] font-semibold leading-snug tracking-tight">
            Prepare, check and review the day&apos;s bids in one place.
          </p>
          <div className="mt-10 rounded-xl border border-white/10 bg-white/[0.03] p-5">
            <PriceCurve readout={false} />
          </div>
        </div>
        <p className="relative text-xs text-white/40">
          Prices shown are illustrative. EnergyTrader does not place orders on an exchange.
        </p>
      </aside>

      <main className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <Link
            href="/"
            className="mb-10 flex items-center gap-2.5 text-[15px] font-semibold tracking-tight text-gray-900 lg:hidden"
          >
            <BrandMark className="h-6 w-6" />
            EnergyTrader
          </Link>

          <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Sign in</h1>
          <p className="mt-2 text-sm text-gray-500">
            {names
              ? `Continue with an approved ${names} account.`
              : localSignIn
                ? "This is a development build, so you can sign in with a display name."
                : "No sign-in method is available."}
          </p>

          {message && (
            <div
              role="alert"
              className="mt-6 rounded-lg border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-red-700"
            >
              {message}
            </div>
          )}

          {oauthProviders.length > 0 && (
            <div className="mt-8 space-y-3">
              {oauthProviders.map((provider) => (
                <form key={provider.id} action={signInWithProvider}>
                  <input type="hidden" name="provider" value={provider.id} />
                  <input type="hidden" name="callbackUrl" value={callbackUrl} />
                  <button
                    type="submit"
                    className={`flex w-full items-center justify-center gap-2.5 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#006DAE] focus-visible:ring-offset-2 ${providerStyle[provider.id].className}`}
                  >
                    {providerStyle[provider.id].mark}
                    Continue with {provider.name}
                  </button>
                </form>
              ))}
            </div>
          )}

          {localSignIn && (
            <>
              {oauthProviders.length > 0 && (
                <div className="my-7 flex items-center gap-3 text-[11px] uppercase tracking-[0.14em] text-gray-400">
                  <span className="h-px flex-1 bg-gray-200" />
                  Development
                  <span className="h-px flex-1 bg-gray-200" />
                </div>
              )}
              <form action={signInLocally} className={oauthProviders.length ? "" : "mt-8"}>
                <input type="hidden" name="callbackUrl" value={callbackUrl} />
                <label htmlFor="name" className="block text-sm font-medium text-gray-700">
                  Display name
                </label>
                <input
                  id="name"
                  name="name"
                  required
                  maxLength={60}
                  autoComplete="nickname"
                  placeholder="Desk North"
                  className="input-field mt-1.5 w-full"
                />
                <button type="submit" className="btn-primary mt-3 w-full py-2.5">
                  Continue
                </button>
                <p className="mt-3 text-xs leading-relaxed text-gray-400">
                  Only <code className="text-gray-500">next dev</code> offers this. It signs you in
                  by name, without a password.
                </p>
              </form>
            </>
          )}

          {!localSignIn && oauthProviders.length === 0 && (
            <p className="mt-6 rounded-lg border border-gray-200 bg-gray-50 px-3.5 py-3 text-sm text-gray-600">
              Set AUTH_VERCEL_ID and AUTH_VERCEL_SECRET, or the GitHub pair, on the web app. See
              docs/AUTH.md.
            </p>
          )}

          <p className="mt-10 border-t border-gray-100 pt-5 text-xs leading-relaxed text-gray-400">
            Sessions last 12 hours. Your account id is recorded with every bid you submit.
          </p>
        </div>
      </main>
    </div>
  );
}
