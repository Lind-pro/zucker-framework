"use client";
import { accountPublicClient } from "@/lib/http-client";
import { refreshAfterPopupSignIn } from "@/lib/account-session";
import { accountReturnPath } from "./account-flow";
import { establishSession } from "./sign-in";

export interface OAuthProvider { id: "google" | "github"; code: boolean; oneTapClientId?: string }
export async function oauthProviders(): Promise<OAuthProvider[]> {
  const result = await accountPublicClient.get<{ providers: OAuthProvider[] }>("/authorize/oauth/providers");
  return Array.isArray(result.providers) ? result.providers.filter(provider => provider && ["google", "github"].includes(provider.id)) : [];
}
export async function acceptOAuthLogin(result: { token: string; returnPath?: string }): Promise<string> {
  if (!result.token || typeof result.token !== "string") throw new Error("Missing account session");
  await establishSession(result.token);
  return accountReturnPath(result.returnPath ?? null);
}
/**
 * After a popup sign-in, the session lives only in the HttpOnly refresh cookie the popup received.
 * The opener trusts the popup's "done" message only once this refresh returns an access token.
 */
export async function restoreSessionFromCookie(): Promise<string> {
  const { access_token } = await refreshAfterPopupSignIn();
  return access_token;
}
export function oauthError(error: unknown): string {
  if (error && typeof error === "object" && "status" in error) {
    if (error.status === 409) return "oauthAccountExists";
    if (error.status === 400) return "oauthExpired";
    if (error.status === 429) return "tooManyRequests";
  }
  return "oauthFailed";
}
export function providerAuthorizationUrl(value: unknown, provider: OAuthProvider["id"]): string {
  if (typeof value !== "string") throw new Error("Missing provider URL");
  const url = new URL(value);
  const expected = provider === "google" ? "https://accounts.google.com/o/oauth2/v2/auth" : "https://github.com/login/oauth/authorize";
  if (`${url.origin}${url.pathname}` !== expected || url.username || url.password) throw new Error("Invalid provider URL");
  return url.href;
}
interface GoogleIdentity {
  initialize(options: { client_id: string; nonce: string; auto_select: boolean; callback: (response: { credential?: string }) => void }): void;
  prompt(listener: (moment: { isNotDisplayed?: () => boolean; isSkippedMoment?: () => boolean }) => void): void;
  cancel(): void;
}
let googleLoader: Promise<GoogleIdentity> | undefined;
export function loadGoogleIdentity(): Promise<GoogleIdentity> {
  const api = () => (window as Window & { google?: { accounts?: { id?: GoogleIdentity } } }).google?.accounts?.id;
  const existing = api(); if (existing) return Promise.resolve(existing);
  if (!googleLoader) googleLoader = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.id = "zucker-google-identity"; script.src = "https://accounts.google.com/gsi/client"; script.async = true;
    script.onload = () => { const loaded = api(); if (loaded) resolve(loaded); else { googleLoader = undefined; reject(new Error("Google sign-in unavailable")); } };
    script.onerror = () => { script.remove(); googleLoader = undefined; reject(new Error("Google sign-in unavailable")); };
    document.head.append(script);
  });
  return googleLoader;
}
