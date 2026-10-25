"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Link, useRouter } from "@/i18n/navigation";
import { accountPublicClient, httpClient } from "@/lib/http-client";
import { AccountForm, buttonClass, FormMessage } from "../../account/_components/AccountForm";
import { useEmailTicket } from "../../account/_components/useEmailTicket";
import { acceptOAuthLogin, oauthError } from "../../account/_components/oauth-client";

export default function OAuthCallbackPage() {
  const t = useTranslations("auth"), router = useRouter(), search = useSearchParams(), proof = useEmailTicket();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const provider = search.get("provider"), linking = search.get("purpose") === "link";
  const valid = proof && ["google", "github"].includes(provider ?? "") && !search.has("error");
  return <AccountForm title={t(linking ? "confirmProviderLink" : "completeProviderLogin")} description={t(linking ? "confirmProviderLinkDescription" : "completeProviderLoginDescription")}>
    {proof === null ? <FormMessage message={t("loadingAccount")} /> : !valid ? <FormMessage message={t("oauthExpired")} error />
      : <button type="button" className={`${buttonClass} w-full`} disabled={busy} onClick={async () => {
        setBusy(true); setError("");
        try {
          if (linking) {
            const result = await httpClient.post<{ success: boolean }>(`/authorize/oauth/${provider}/link/complete`, { proof });
            if (result.success !== true) throw new Error("Link was not confirmed");
            router.replace("/account");
          } else {
            const result = await accountPublicClient.post<{ token: string; returnPath?: string }>(`/authorize/oauth/${provider}/complete`, { proof });
            router.replace(await acceptOAuthLogin(result));
          }
        } catch (failure) { setError(t(oauthError(failure))); }
        finally { setBusy(false); }
      }}>{busy ? t("saving") : t(linking ? "confirmProviderLink" : "completeProviderLogin")}</button>}
    <FormMessage message={error} error />
    <p className="mt-5 text-center"><Link href={linking ? "/account" : "/login"} className="text-primary-500 hover:underline">{t(linking ? "backToAccount" : "goLogin")}</Link></p>
  </AccountForm>;
}
