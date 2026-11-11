"use client";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { claimOAuthPopup, type OAuthPopupClaim } from "@zucker-framework/fe-auth";
import { Link, useRouter } from "@/i18n/navigation";
import { accountPublicClient, httpClient } from "@/lib/http-client";
import { AccountForm, buttonClass, FormMessage } from "../../account/_components/AccountForm";
import { useEmailTicket } from "../../account/_components/useEmailTicket";
import { acceptOAuthLogin, oauthError } from "../../account/_components/oauth-client";
import { accountReturnPath } from "../../account/_components/account-flow";
import { TwoFactorStep } from "@/features/account-security/TwoFactorStep";
import { isPopupState, OAUTH_POPUP_STATE_KEY, signInResult } from "@/features/account-security/sign-in-flow";

/** Popup channel state left by /oauth/popup in this window; read once so a later redirect sign-in in this tab is not affected. */
function takePopupState(): string | null {
  try {
    const value = window.sessionStorage.getItem(OAUTH_POPUP_STATE_KEY);
    window.sessionStorage.removeItem(OAUTH_POPUP_STATE_KEY);
    return isPopupState(value) ? value : null;
  } catch { return null; }
}

export default function OAuthCallbackPage() {
  const t = useTranslations("auth"), router = useRouter(), search = useSearchParams(), proof = useEmailTicket();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [challenge, setChallenge] = useState<{ value: string; returnPath?: string } | null>(null);
  // undefined = still asking whether an opener claims this sign-in; null = normal redirect completion.
  const [claim, setClaim] = useState<OAuthPopupClaim | null | undefined>(undefined);
  const claimed = useRef<Promise<OAuthPopupClaim | null> | null>(null);
  const provider = search.get("provider"), linking = search.get("purpose") === "link";
  const valid = proof && ["google", "github"].includes(provider ?? "") && !search.has("error");
  useEffect(() => {
    // Linking always runs in the account tab (redirect flow); only sign-in uses the popup.
    if (!claimed.current) {
      const state = linking ? null : takePopupState();
      claimed.current = state ? claimOAuthPopup(state) : Promise.resolve(null);
    }
    let active = true;
    void claimed.current.then(value => { if (active) setClaim(value); });
    return () => { active = false; };
  }, [linking]);
  // A popup whose provider step failed has nothing to complete: report it to the opener (closes this window).
  useEffect(() => { if (claim && proof !== null && !valid) claim.fail("oauthExpired"); }, [claim, proof, valid]);
  const signedIn = async (token: string, returnPath: string | undefined) => {
    if (claim) { claim.complete(accountReturnPath(returnPath ?? null)); return; }
    router.replace(await acceptOAuthLogin({ token, returnPath }));
  };
  const fail = (failure: unknown) => {
    const code = oauthError(failure);
    if (claim) claim.fail(code); else setError(t(code));
  };
  return <AccountForm title={t(linking ? "confirmProviderLink" : "completeProviderLogin")} description={t(linking ? "confirmProviderLinkDescription" : "completeProviderLoginDescription")}>
    {proof === null || claim === undefined ? <FormMessage message={t("loadingAccount")} /> : !valid ? <FormMessage message={t("oauthExpired")} error />
      : challenge ? <TwoFactorStep challenge={challenge.value} onSignedIn={token => signedIn(token, challenge.returnPath)}
        onRestart={() => { if (claim) { claim.release(); window.close(); } else router.replace("/login"); }} />
      : <button type="button" className={`${buttonClass} w-full`} disabled={busy} onClick={async () => {
        setBusy(true); setError("");
        try {
          if (linking) {
            const result = await httpClient.post<{ success: boolean }>(`/authorize/oauth/${provider}/link/complete`, { proof });
            if (result.success !== true) throw new Error("Link was not confirmed");
            router.replace("/account");
          } else {
            const result = signInResult(await accountPublicClient.post<unknown>(`/authorize/oauth/${provider}/complete`, { proof }));
            if (result.kind === "two-factor") setChallenge({ value: result.challenge, returnPath: result.returnPath });
            else await signedIn(result.token, result.returnPath);
          }
        } catch (failure) { fail(failure); }
        finally { setBusy(false); }
      }}>{busy ? t("saving") : t(linking ? "confirmProviderLink" : "completeProviderLogin")}</button>}
    <FormMessage message={error} error />
    <p className="mt-5 text-center"><Link href={linking ? "/account" : "/login"} className="text-primary-500 hover:underline">{t(linking ? "backToAccount" : "goLogin")}</Link></p>
  </AccountForm>;
}
