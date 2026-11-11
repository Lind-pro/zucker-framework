"use client";
import { SocialSignIn } from "../account/_components/SocialSignIn";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Link, useRouter } from "@/i18n/navigation";
import { accountPublicClient } from "@/lib/http-client";
import { AccountForm, buttonClass, FormMessage, inputClass } from "../account/_components/AccountForm";
import { accountErrorKey, accountReturnPath } from "../account/_components/account-flow";
import { establishSession } from "../account/_components/sign-in";
import { useEmailTicket } from "../account/_components/useEmailTicket";
import { TwoFactorStep } from "@/features/account-security/TwoFactorStep";
import { MagicLinkRequest } from "@/features/account-security/MagicLinkRequest";
import { CancelDeletionByTicket, DeletionPendingNotice } from "@/features/account-security/DeletionPending";
import { loginStep, signInResult, type LoginStep } from "@/features/account-security/sign-in-flow";

export default function LoginPage() {
  const t = useTranslations("auth");
  const router = useRouter();
  const searchParams = useSearchParams();
  const cancelTicket = useEmailTicket("cancel-deletion");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [step, setStep] = useState<LoginStep>({ step: "credentials" });
  const [ticketHandled, setTicketHandled] = useState(false);
  const finish = async (token: string) => {
    await establishSession(token);
    router.replace(accountReturnPath(searchParams.get("redirect")));
  };
  const login = async () => {
    setError(""); setLoading(true);
    try {
      const result = signInResult(await accountPublicClient.post<unknown>("/authorize/login", { username, password }));
      setStep(current => loginStep(current, { type: "result", result }));
      if (result.kind === "session") await finish(result.token);
      else setPassword("");
    } catch (failure) {
      const next = loginStep(step, { type: "failure", error: failure });
      if (next.step === "deletion-pending") setStep(next);
      else setError(t(accountErrorKey(failure, "loginFailed")));
    } finally { setLoading(false); }
  };
  const restart = () => { setStep({ step: "credentials" }); setError(""); };
  return <AccountForm title={t("loginTitle")} description={t("loginDescription")}>
    {searchParams.get("changed") === "1" && <div className="mb-4"><FormMessage message={t("passwordChanged")} /></div>}
    {cancelTicket && !ticketHandled && <CancelDeletionByTicket ticket={cancelTicket} onDone={() => setTicketHandled(true)} />}
    {step.step === "two-factor" ? <TwoFactorStep challenge={step.challenge} onSignedIn={finish} onRestart={restart} />
      : step.step === "deletion-pending" ? <DeletionPendingNotice executeAfter={step.executeAfter} credentials={{ username, password }}
        onCancelled={login} onBack={restart} />
      : <>
        <form className="space-y-4" onSubmit={event => { event.preventDefault(); void login(); }}>
          <div><label htmlFor="login-username" className="block text-sm font-medium mb-1.5">{t("username")}</label>
            <input id="login-username" name="username" autoComplete="username" required className={inputClass} value={username} onChange={(event) => setUsername(event.target.value)} /></div>
          <div><label htmlFor="login-password" className="block text-sm font-medium mb-1.5">{t("password")}</label>
            <input id="login-password" name="password" type="password" autoComplete="current-password" required className={inputClass} value={password} onChange={(event) => setPassword(event.target.value)} /></div>
          <FormMessage message={error} error />
          <div className="flex flex-wrap justify-between gap-2 text-sm">
            <Link href="/verify-email" className="text-primary-500 underline-offset-4 hover:underline">{t("verifyEmailLink")}</Link>
            <Link href="/forgot-password" className="text-primary-500 underline-offset-4 hover:underline">{t("forgotPassword")}</Link>
          </div>
          <button type="submit" disabled={loading} className={`${buttonClass} w-full`}>{loading ? t("signingIn") : t("loginButton")}</button>
        </form>
        <MagicLinkRequest />
        <SocialSignIn />
        <p className="mt-6 text-center text-sm text-[var(--color-muted)]">{t("noAccount")} <Link href="/register" className="text-primary-500 hover:underline">{t("goRegister")}</Link></p>
      </>}
  </AccountForm>;
}
