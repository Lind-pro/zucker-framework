"use client";
import { useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { claimOAuthPopup } from "@zucker-framework/fe-auth";
import { accountPublicClient } from "@/lib/http-client";
import { AccountForm, FormMessage } from "../../account/_components/AccountForm";
import { oauthError, providerAuthorizationUrl } from "../../account/_components/oauth-client";
import { OAUTH_POPUP_STATE_KEY, parsePopupStart } from "@/features/account-security/sign-in-flow";

/**
 * First page of a popup sign-in, opened by `SocialSignIn` with `#provider=…&state=…&returnPath=…`.
 * It keeps the channel state in this window's sessionStorage (it survives the provider round trip
 * and is never shared with other tabs), starts the OAuth flow from this window so the browser-binding
 * cookie and intent belong to it, then navigates to the provider. /oauth/callback reads the state once.
 */
export default function OAuthPopupStartPage() {
  const t = useTranslations("auth"), locale = useLocale();
  const [error, setError] = useState("");
  // One start per window, also under Strict Mode's repeated effects (the fragment is read and removed once).
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const start = parsePopupStart(window.location.hash);
    window.history.replaceState(window.history.state, "", window.location.pathname);
    void (async () => {
      if (!start) { setError(t("oauthExpired")); return; }
      try {
        window.sessionStorage.setItem(OAUTH_POPUP_STATE_KEY, start.state);
        const result = await accountPublicClient.post<{ authorizationUrl?: string }>(`/authorize/oauth/${start.provider}/start`,
          { locale, mode: "code", returnPath: start.returnPath });
        window.location.replace(providerAuthorizationUrl(result.authorizationUrl, start.provider));
      } catch (failure) {
        try { window.sessionStorage.removeItem(OAUTH_POPUP_STATE_KEY); } catch { /* storage unavailable */ }
        const code = oauthError(failure);
        // Report to the opener (which then shows the error and this window closes); without one, explain here.
        const claim = await claimOAuthPopup(start.state);
        if (claim) claim.fail(code); else setError(t(code));
      }
    })();
  }, [locale, t]);
  return <AccountForm title={t("completeProviderLogin")} description={t("completeProviderLoginDescription")}>
    {error ? <FormMessage message={error} error /> : <FormMessage message={t("loadingAccount")} />}
  </AccountForm>;
}
