"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { useRouter } from "@/i18n/navigation";
import { accountPublicClient, httpClient } from "@/lib/http-client";
import { accountReturnPath } from "./account-flow";
import { FormMessage } from "./AccountForm";
import { acceptOAuthLogin, loadGoogleIdentity, oauthError, oauthProviders, providerAuthorizationUrl, type OAuthProvider } from "./oauth-client";

export function SocialSignIn({ purpose = "login", configured, onLinked }: { purpose?: "login" | "link"; configured?: OAuthProvider[]; onLinked?: () => void }) {
  const locale = useLocale(), t = useTranslations("auth"), router = useRouter(), search = useSearchParams();
  const [providers, setProviders] = useState<OAuthProvider[]>([]), [busy, setBusy] = useState(""), [error, setError] = useState("");
  const operation = useRef(0), cancelPrompt = useRef<(() => void) | null>(null);
  const cancel = useCallback(() => { operation.current++; cancelPrompt.current?.(); }, []);
  useEffect(() => {
    let active = true;
    if (!configured) void oauthProviders().then(value => { if (active) setProviders(value); }).catch(() => {});
    return () => { active = false; cancel(); };
  }, [configured, cancel]);
  const available = configured ?? providers;
  const linking = purpose === "link";
  const start = async (provider: OAuthProvider, oneTap: boolean) => {
    const current = ++operation.current;
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
              const session = await accountPublicClient.post<{ token: string; returnPath?: string }>("/authorize/oauth/google/complete", { proof: handoff.proof });
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
  return <section className="mt-6 space-y-3 border-t border-[var(--color-border)] pt-6" aria-label={t(linking ? "connectProvider" : "socialSignIn")}>
    <p className="text-center text-sm text-[var(--color-muted)]">{t(linking ? "connectProvider" : "socialSignIn")}</p>
    {available.filter(provider => provider.code).map(provider => <button key={provider.id} type="button" disabled={Boolean(busy)}
      className="w-full rounded-lg border border-[var(--color-border)] px-4 py-2.5 font-medium disabled:opacity-60" onClick={() => void start(provider, false)}>
      {t(linking ? "connectWithProvider" : "continueWithProvider", { provider: provider.id === "google" ? "Google" : "GitHub" })}</button>)}
    {available.filter(provider => provider.oneTapClientId).map(provider => <button key={`${provider.id}-onetap`} type="button" disabled={Boolean(busy)}
      className="w-full rounded-lg border border-[var(--color-border)] px-4 py-2.5 font-medium disabled:opacity-60" onClick={() => void start(provider, true)}>{t(linking ? "linkGoogleOneTap" : "googleOneTap")}</button>)}
    {busy === "google-onetap" && <button type="button" className="text-sm underline" onClick={() => { cancel(); setBusy(""); }}>{t("cancelGoogleSignIn")}</button>}
    <FormMessage message={error} error />
  </section>;
}
