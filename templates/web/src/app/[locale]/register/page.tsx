"use client";
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Link, useRouter } from "@/i18n/navigation";
import { accountPublicClient } from "@/lib/http-client";
import { AccountForm, buttonClass, FormMessage, inputClass } from "../account/_components/AccountForm";
import { accountErrorKey, registerOutcome } from "../account/_components/account-flow";
import { establishSession } from "../account/_components/sign-in";
import { captureUtmSource, readUtmSource } from "@/features/landing/utm";

export default function RegisterPage() {
  const t = useTranslations("auth"), locale = useLocale(), router = useRouter();
  const [form, setForm] = useState({ username: "", email: "", password: "", confirmPassword: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [registered, setRegistered] = useState(false);
  return <AccountForm title={t("registerTitle")} description={t("registerDescription")}>
    {registered ? <div className="space-y-4"><FormMessage message={t("registrationAccepted")} /><Link href="/verify-email" className="text-primary-500 hover:underline">{t("resendVerification")}</Link></div>
      : <form className="space-y-4" onSubmit={async (event) => {
        event.preventDefault(); setError("");
        if (form.password !== form.confirmPassword) { setError(t("passwordMismatch")); return; }
        setLoading(true);
        try {
          // First-touch acquisition source (optional; the Server sanitises it again).
          captureUtmSource(window.location.search);
          const utm = readUtmSource();
          const outcome = registerOutcome(await accountPublicClient.post<unknown>("/authorize/register", {
            username: form.username, email: form.email, password: form.password, locale, ...(utm ? { utm } : {}),
          }));
          setForm({ username: "", email: "", password: "", confirmPassword: "" });
          if (outcome.kind === "verify") { setRegistered(true); return; }
          // Verification is off: the account exists and the server already opened its session.
          await establishSession(outcome.token);
          router.replace("/account");
        } catch (failure) { setError(t(accountErrorKey(failure, "registrationFailed"))); }
        finally { setLoading(false); }
      }}>
        {(["username", "email", "password", "confirmPassword"] as const).map((field) => <div key={field}>
          <label htmlFor={`register-${field}`} className="block text-sm font-medium mb-1.5">{t(field)}</label>
          <input id={`register-${field}`} name={field} type={field.toLowerCase().includes("password") ? "password" : field === "email" ? "email" : "text"}
            autoComplete={field.toLowerCase().includes("password") ? "new-password" : field} required
            minLength={field.toLowerCase().includes("password") ? 8 : undefined} maxLength={field.toLowerCase().includes("password") ? 128 : 254}
            className={inputClass} value={form[field]} onChange={(event) => setForm({ ...form, [field]: event.target.value })} />
        </div>)}
        <p className="text-xs text-[var(--color-muted)]">{t("passwordRequirements")}</p>
        <FormMessage message={error} error />
        <button type="submit" disabled={loading} className={`${buttonClass} w-full`}>{loading ? t("registering") : t("registerButton")}</button>
      </form>}
    <p className="mt-6 text-center text-sm text-[var(--color-muted)]">{t("hasAccount")} <Link href="/login" className="text-primary-500 hover:underline">{t("goLogin")}</Link></p>
  </AccountForm>;
}
