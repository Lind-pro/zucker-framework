"use client";
import { SocialSignIn } from "../account/_components/SocialSignIn";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Link, useRouter } from "@/i18n/navigation";
import { useAuthStore } from "@/lib/stores/auth-store";
import { accountPublicClient, httpClient } from "@/lib/http-client";
import { AccountForm, buttonClass, FormMessage, inputClass } from "../account/_components/AccountForm";
import { accountErrorKey, accountPermissions, accountReturnPath, type AccountIdentity } from "../account/_components/account-flow";

export default function LoginPage() {
  const t = useTranslations("auth");
  const router = useRouter();
  const searchParams = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  return <AccountForm title={t("loginTitle")} description={t("loginDescription")}>
    {searchParams.get("changed") === "1" && <div className="mb-4"><FormMessage message={t("passwordChanged")} /></div>}
    <form className="space-y-4" onSubmit={async (event) => {
      event.preventDefault(); setError(""); setLoading(true);
      let issued = false;
      try {
        const result = await accountPublicClient.post<{ token: string }>("/authorize/login", { username, password });
        if (!result.token) throw new Error("Missing access token");
        issued = true;
        useAuthStore.getState().updateToken(result.token);
        const me = await httpClient.get<AccountIdentity>("/authorize/me");
        useAuthStore.getState().setAuthState({ token: useAuthStore.getState().token || result.token,
          user: { id: me.id, username: me.username, name: me.name, email: me.email },
          permissions: accountPermissions(me) });
        router.replace(accountReturnPath(searchParams.get("redirect")));
      } catch (failure) {
        if (issued) useAuthStore.getState().logout();
        setError(t(accountErrorKey(failure, "loginFailed")));
      } finally { setLoading(false); }
    }}>
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
    <SocialSignIn />
    <p className="mt-6 text-center text-sm text-[var(--color-muted)]">{t("noAccount")} <Link href="/register" className="text-primary-500 hover:underline">{t("goRegister")}</Link></p>
  </AccountForm>;
}
