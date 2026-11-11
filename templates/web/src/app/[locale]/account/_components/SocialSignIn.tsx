"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { openOAuthPopup } from "@zucker-framework/fe-auth";
import { useRouter } from "@/i18n/navigation";
import { accountPublicClient, httpClient } from "@/lib/http-client";
import { localizedPath } from "@/lib/site/url";
import { isLocale } from "@/lib/site/locales";
import { TwoFactorStep } from "@/features/account-security/TwoFactorStep";
import { newPopupState, popupFailureKey, popupStartFragment, signInResult } from "@/features/account-security/sign-in-flow";
import { accountReturnPath } from "./account-flow";
import { FormMessage } from "./AccountForm";
import { acceptOAuthLogin, loadGoogleIdentity, oauthError, oauthProviders, providerAuthorizationUrl, restoreSessionFromCookie, type OAuthProvider } from "./oauth-client";

export function SocialSignIn({ purpose = "login", configured, onLinked }: { purpose?: "login" | "link"; configured?: OAuthProvider[]; onLinked?: () => void }) {
  const locale = useLocale(), t = useTranslations("auth"), router = useRouter(), search = useSearchParams();
  const [providers, setProviders] = useState<OAuthProvider[]>([]), [busy, setBusy] = useState(""), [error, setError] = useState("");
  const [challenge, setChallenge] = useState<{ value: string; returnPath?: string } | null>(null);
  const operation = useRef(0), cancelPrompt = useRef<(() => void) | null>(null);
  const cancel = useCallback(() => { operation.current++; cancelPrompt.current?.(); }, []);
  useEffect(() => {
    let active = true;
    if (!configured) void oauthProviders().then(value => { if (active) setProviders(value); }).catch(() => {});
    return () => { active = false; cancel(); };
  }, [configured, cancel]);
  const available = configured ?? providers;
  const linking = purpose === "link";
  /**
   * Sign-in (not linking) opens the provider in a popup first. `openOAuthPopup` must run synchronously
   * in the click handler; the popup page starts the flow itself and the callback page completes it
   * there. Nothing secret crosses the channel: a `completed` popup is trusted only once the cookie
   * refresh returns a session here. A blocked popup falls back to the redirect flow below.
   */
  const popup = async (provider: OAuthProvider) => {
    const current = ++operation.current;
    const state = newPopupState(), returnPath = accountReturnPath(search.get("redirect"));
    const pending = openOAuthPopup({ url: `${localizedPath(isLocale(locale) ? locale : "en", "/oauth/popup")}#${popupStartFragment(provider.id, state, returnPath)}`, state });
    setBusy(`${provider.id}-popup`); setError("");
    const result = await pending;
    if (operation.current !== current) return;
    if (result.status === "blocked") { await start(provider, false, current); return; }
    try {
      if (result.status === "completed") {
        const token = await restoreSessionFromCookie();
        if (operation.current !== current) return;
        router.replace(await acceptOAuthLogin({ token, returnPath: result.returnPath ?? returnPath }));
        return;
      }
      if (result.status === "failed") setError(t(popupFailureKey(result.code)));
      else if (result.status === "timeout") setError(t("oauthFailed"));
      setBusy("");
    } catch (failure) { if (operation.current === current) { setError(t(oauthError(failure))); setBusy(""); } }
  };
  const start = async (provider: OAuthProvider, oneTap: boolean, resumed?: number) => {
    const current = resumed ?? ++operation.current;
    setBusy(`${provider.id}-${oneTap ? "onetap" : "code"}`); setError("");
    try {
      const result = await (linking ? httpClient : accountPublicClient).post<{ authorizationUrl?: string; intent?: string; nonce?: string; clientId?: string }>(
        `/authorize/oauth/${provider.id}/${linking ? "link/" : ""}start`, { locale, mode: oneTap ? "onetap" : "code", returnPath: accountReturnPath(search.get("redirect")) });
      if (!oneTap) { window.location.assign(providerAuthorizationUrl(result.authorizationUrl, provider.id)); return; }
      if (!result.intent || !result.nonce || !result.clientId || result.clientId !== provider.oneTapClientId) throw new Error("Invalid sign-in intent");
      const google = await loadGoogleIdentity();
      if (operation.current !== current) return;
      let handled = false;
      cancelPrompt.current = () => google.cancel();
      google.initialize({ client_id: result.clientId, nonce: result.nonce, auto_select: false, callback: response => {
        if (handled || operation.current !== current) return; handled = true; setBusy("google-completing");
        void (async () => {
          try {
            if (!response.credential) throw new Error("Missing provider credential");
            const handoff = await accountPublicClient.post<{ proof: string }>("/authorize/oauth/google/onetap", { intent: result.intent, credential: response.credential });
            if (operation.current !== current) return;
            if (linking) {
              const result = await httpClient.post<{ success: boolean }>("/authorize/oauth/google/link/complete", { proof: handoff.proof });
              if (result.success !== true) throw new Error("Link was not confirmed");
              setBusy(""); onLinked?.();
            } else {
              const session = signInResult(await accountPublicClient.post<unknown>("/authorize/oauth/google/complete", { proof: handoff.proof }));
              if (operation.current !== current) return;
              if (session.kind === "two-factor") { setChallenge({ value: session.challenge, returnPath: session.returnPath }); setBusy(""); return; }
              router.replace(await acceptOAuthLogin(session));
            }
          } catch (failure) { if (operation.current === current) { setError(t(oauthError(failure))); setBusy(""); } }
        })();
      } });
      google.prompt(moment => {
        if (!handled && operation.current === current && (moment.isNotDisplayed?.() || moment.isSkippedMoment?.())) {
          setBusy(""); setError(t("oneTapUnavailable"));
        }
      });
    } catch (failure) { if (operation.current === current) { setError(t(oauthError(failure))); setBusy(""); } }
  };
  if (!available.length) return null;
  if (challenge) return <section className="mt-6 border-t border-[var(--color-border)] pt-6">
    <TwoFactorStep challenge={challenge.value} onRestart={() => setChallenge(null)}
      onSignedIn={async token => router.replace(await acceptOAuthLogin({ token, returnPath: challenge.returnPath }))} />
  </section>;
  return <section className="mt-6 space-y-3 border-t border-[var(--color-border)] pt-6" aria-label={t(linking ? "connectProvider" : "socialSignIn")}>
    <p className="text-center text-sm text-[var(--color-muted)]">{t(linking ? "connectProvider" : "socialSignIn")}</p>
    {available.filter(provider => provider.code).map(provider => <button key={provider.id} type="button" disabled={Boolean(busy)}
      className="w-full rounded-lg border border-[var(--color-border)] px-4 py-2.5 font-medium disabled:opacity-60" onClick={() => void (linking ? start(provider, false) : popup(provider))}>
      {t(linking ? "connectWithProvider" : "continueWithProvider", { provider: provider.id === "google" ? "Google" : "GitHub" })}</button>)}
    {available.filter(provider => provider.oneTapClientId).map(provider => <button key={`${provider.id}-onetap`} type="button" disabled={Boolean(busy)}
      className="w-full rounded-lg border border-[var(--color-border)] px-4 py-2.5 font-medium disabled:opacity-60" onClick={() => void start(provider, true)}>{t(linking ? "linkGoogleOneTap" : "googleOneTap")}</button>)}
    {busy === "google-onetap" && <button type="button" className="text-sm underline" onClick={() => { cancel(); setBusy(""); }}>{t("cancelGoogleSignIn")}</button>}
    <FormMessage message={error} error />
  </section>;
}
