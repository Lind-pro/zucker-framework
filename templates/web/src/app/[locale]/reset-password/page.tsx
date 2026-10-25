"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { accountPublicClient } from "@/lib/http-client";
import { useAuthStore } from "@/lib/stores/auth-store";
import { AccountForm, buttonClass, FormMessage, inputClass } from "../account/_components/AccountForm";
import { accountErrorKey } from "../account/_components/account-flow";
import { useEmailTicket } from "../account/_components/useEmailTicket";

export default function ResetPasswordPage() {
  const t = useTranslations("auth"), ticket = useEmailTicket();
  const [password, setPassword] = useState(""), [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false), [complete, setComplete] = useState(false), [error, setError] = useState("");
  return <AccountForm title={t("resetTitle")} description={t("resetDescription")}>
    {complete ? <FormMessage message={t("passwordChanged")} /> : ticket === null ? <FormMessage message={t("readingLink")} /> : !ticket ? <div className="space-y-4">
      <FormMessage message={t("invalidTicket")} error /><Link href="/forgot-password" className="text-primary-500 hover:underline">{t("sendResetLink")}</Link>
    </div> : <form className="space-y-4" onSubmit={async (event) => {
      event.preventDefault(); setError("");
      if (password !== confirm) { setError(t("passwordMismatch")); return; }
      setBusy(true);
      try {
        const result = await accountPublicClient.post<{ success: boolean }>("/authorize/reset-password", { ticket, password });
        if (result.success !== true) throw new Error("Unexpected reset response");
        useAuthStore.getState().logout(); setPassword(""); setConfirm(""); setComplete(true);
      } catch (failure) { setError(t(accountErrorKey(failure, "resetFailed"))); }
      finally { setBusy(false); }
    }}>
      <div><label htmlFor="reset-password" className="mb-1.5 block text-sm font-medium">{t("newPassword")}</label>
        <input id="reset-password" name="password" type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} className={inputClass} /></div>
      <div><label htmlFor="reset-confirm" className="mb-1.5 block text-sm font-medium">{t("confirmPassword")}</label>
        <input id="reset-confirm" name="confirmPassword" type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={confirm} onChange={(event) => setConfirm(event.target.value)} className={inputClass} /></div>
      <p className="text-xs text-[var(--color-muted)]">{t("passwordRequirements")}</p>
      <FormMessage message={error} error />
      <button type="submit" className={`${buttonClass} w-full`} disabled={busy}>{busy ? t("saving") : t("resetButton")}</button>
    </form>}
    <Link href="/login" className="mt-6 block text-center text-sm text-primary-500 hover:underline">{t("goLogin")}</Link>
  </AccountForm>;
}
