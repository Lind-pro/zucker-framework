"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { accountPublicClient } from "@/lib/http-client";
import { AccountForm, buttonClass, FormMessage } from "../account/_components/AccountForm";
import { accountErrorKey } from "../account/_components/account-flow";
import { RequestAccountEmail } from "../account/_components/RequestAccountEmail";
import { useEmailTicket } from "../account/_components/useEmailTicket";

export default function VerifyEmailPage() {
  const t = useTranslations("auth"), ticket = useEmailTicket();
  const [busy, setBusy] = useState(false), [verified, setVerified] = useState(false), [error, setError] = useState("");
  return <AccountForm title={t("verifyTitle")} description={t("verifyDescription")}>
    <div className="space-y-5">
      {verified ? <FormMessage message={t("emailVerified")} /> : ticket === null ? <FormMessage message={t("readingLink")} /> : <>
        {ticket ? <button className={`${buttonClass} w-full`} disabled={busy} onClick={async () => {
          setBusy(true); setError("");
          try {
            const result = await accountPublicClient.post<{ success: boolean }>("/authorize/verify-email", { ticket });
            if (result.success !== true) throw new Error("Unexpected verification response");
            setVerified(true);
          } catch (failure) { setError(t(accountErrorKey(failure, "verificationFailed"))); }
          finally { setBusy(false); }
        }}>{busy ? t("verifying") : t("verifyButton")}</button> : <FormMessage message={t("verificationInstructions")} />}
        <FormMessage message={error} error />
        <div className="border-t border-[var(--color-border)] pt-5"><RequestAccountEmail purpose="verification" /></div>
      </>}
      <Link href="/login" className="block text-center text-sm text-primary-500 hover:underline">{t("goLogin")}</Link>
    </div>
  </AccountForm>;
}
