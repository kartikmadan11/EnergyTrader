"use server";

import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { localSignIn, oauthProviders, signIn } from "@/auth";
import { safeCallbackPath } from "@/lib/access";

/** Auth.js throws its errors from server actions; show them on the sign-in page instead. */
async function withErrorPage(callbackUrl: string, attempt: () => Promise<unknown>) {
  try {
    await attempt();
  } catch (error) {
    // A successful sign-in finishes by throwing Next's redirect, which must propagate.
    if (!(error instanceof AuthError)) throw error;
    const params = new URLSearchParams({ error: error.type, callbackUrl });
    redirect(`/login?${params}`);
  }
}

export async function signInWithProvider(formData: FormData) {
  const provider = String(formData.get("provider") ?? "");
  const callbackUrl = safeCallbackPath(String(formData.get("callbackUrl") ?? ""));
  if (!oauthProviders.some((p) => p.id === provider)) {
    redirect(`/login?${new URLSearchParams({ error: "Configuration", callbackUrl })}`);
  }
  await withErrorPage(callbackUrl, () => signIn(provider, { redirectTo: callbackUrl }));
}

export async function signInLocally(formData: FormData) {
  const callbackUrl = safeCallbackPath(String(formData.get("callbackUrl") ?? ""));
  if (!localSignIn) {
    redirect(`/login?${new URLSearchParams({ error: "Configuration", callbackUrl })}`);
  }
  await withErrorPage(callbackUrl, () =>
    signIn("local", { name: String(formData.get("name") ?? ""), redirectTo: callbackUrl }),
  );
}
