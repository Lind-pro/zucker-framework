"use client";
import { AccountApiKeys } from "./_components/ApiKeys";
import { OAuthConnections } from "./_components/OAuthConnections";
import { AccountBillingLink } from "@/features/billing/AccountBillingLink";
import { AccountCreditsLink } from "@/features/credits/AccountCreditsLink";
import { AvatarSection } from "@/features/account-avatar/AvatarSection";
import { AccountFilesLink } from "@/features/files/AccountFilesLink";
import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { accountPublicClient, httpClient } from "@/lib/http-client";
import { useAuthStore } from "@/lib/stores/auth-store";
import { accountErrorKey, accountPermissions, type AccountIdentity } from "./_components/account-flow";
import { buttonClass, FormMessage, inputClass, panelClass } from "./_components/AccountForm";

function ProfileSection() {
  const t = useTranslations("auth"), locale = useLocale(), router = useRouter();
  const [identity, setIdentity] = useState<AccountIdentity | null>(null);
  const [name, setName] = useState(""), [language, setLanguage] = useState(locale);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [saved, setSaved] = useState(false), [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    void httpClient.get<AccountIdentity>("/authorize/me").then((me) => {
      if (!active) return;
      setIdentity(me); setName(me.name || me.username);
      const state = useAuthStore.getState();
      if (state.token) state.setAuthState({ token: state.token, user: { id: me.id, username: me.username, name: me.name, email: me.email }, permissions: accountPermissions(me) });
    }).catch((failure) => { if (active) setError(t(accountErrorKey(failure, "profileLoadFailed"))); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision, t]);
  return <section className={`${panelClass} space-y-4`} aria-label={t("profileTitle")}>
    <h2 className="text-xl font-semibold">{t("profileTitle")}</h2>
    {loading ? <FormMessage message={t("loadingAccount")} /> : identity ? <form className="space-y-4" onSubmit={async (event) => {
      event.preventDefault(); setBusy(true); setError(""); setSaved(false);
      try {
        const result = await httpClient.post<{ success: boolean }>("/authorize/profile", { name: name.trim(), locale: language });
        if (result.success !== true) throw new Error("Unexpected profile response");
        setSaved(true);
        useAuthStore.getState().updateUser({ id: identity.id, username: identity.username, name: name.trim(), email: identity.email });
        if (language !== locale) router.replace("/account", { locale: language });
      } catch (failure) { setError(t(accountErrorKey(failure, "profileSaveFailed"))); }
      finally { setBusy(false); }
    }}>
      <dl className="grid gap-2 text-sm"><div><dt className="text-[var(--color-muted)]">{t("username")}</dt><dd>{identity.username}</dd></div>
        <div><dt className="text-[var(--color-muted)]">{t("email")}</dt><dd className="break-all">{identity.email || t("notRecorded")}</dd></div></dl>
      <div><label htmlFor="profile-name" className="mb-1.5 block text-sm font-medium">{t("displayName")}</label>
        <input id="profile-name" name="name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={100} disabled={busy} autoComplete="name" className={inputClass} /></div>
      <div><label htmlFor="profile-language" className="mb-1.5 block text-sm font-medium">{t("language")}</label>
        <select id="profile-language" value={language} onChange={(event) => setLanguage(event.target.value)} disabled={busy} className={inputClass}><option value="zh">中文</option><option value="en">English</option></select></div>
      <button type="submit" className={buttonClass} disabled={busy}>{busy ? t("saving") : t("saveProfile")}</button>
      {saved && <FormMessage message={t("profileSaved")} />}
    </form> : <button className={buttonClass} onClick={() => { setLoading(true); setError(""); setRevision((value) => value + 1); }}>{t("retry")}</button>}
    <FormMessage message={error} error />
  </section>;
}

function PasswordSection() {
  const t = useTranslations("auth"), router = useRouter();
  const [currentPassword, setCurrentPassword] = useState(""), [password, setPassword] = useState(""), [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <section className={`${panelClass} space-y-4`} aria-label={t("changePasswordTitle")}>
    <h2 className="text-xl font-semibold">{t("changePasswordTitle")}</h2>
    <p className="text-sm text-[var(--color-muted)]">{t("changePasswordDescription")}</p>
    <form className="space-y-4" onSubmit={async (event) => {
      event.preventDefault(); setError("");
      if (password !== confirm) { setError(t("passwordMismatch")); return; }
      setBusy(true);
      try {
        // Refresh an expired access token through a read, before distinguishing credential rejection below.
        await httpClient.get<AccountIdentity>("/authorize/me");
        // A rejected current password is not a signal to rotate/revoke the current session.
        const result = await accountPublicClient.post<{ success: boolean }>("/authorize/password", { currentPassword, password }, undefined,
          { headers: { Authorization: `Bearer ${useAuthStore.getState().token || ""}` } });
        if (result.success !== true) throw new Error("Unexpected password response");
        useAuthStore.getState().logout(); router.replace("/login?changed=1");
      } catch (failure) { setError(t(accountErrorKey(failure, "passwordChangeFailed"))); }
      finally { setBusy(false); }
    }}>
      {[
        { id: "current-password", label: "currentPassword", value: currentPassword, change: setCurrentPassword, current: true },
        { id: "new-password", label: "newPassword", value: password, change: setPassword, current: false },
        { id: "confirm-password", label: "confirmPassword", value: confirm, change: setConfirm, current: false },
      ].map((field) => <div key={field.id}><label htmlFor={field.id} className="mb-1.5 block text-sm font-medium">{t(field.label)}</label>
        <input id={field.id} type="password" autoComplete={field.current ? "current-password" : "new-password"} required minLength={field.current ? undefined : 8} maxLength={128}
          disabled={busy} value={field.value} onChange={(event) => field.change(event.target.value)} className={inputClass} /></div>)}
      <p className="text-xs text-[var(--color-muted)]">{t("passwordRequirements")}</p>
      <FormMessage message={error} error />
      <button type="submit" className={buttonClass} disabled={busy}>{busy ? t("saving") : t("changePasswordButton")}</button>
    </form>
  </section>;
}

interface Session { id: string; current: boolean; expiresAt: string; lastActiveAt: string | null }
function SessionsSection() {
  const t = useTranslations("auth"), locale = useLocale(), router = useRouter();
  const [sessions, setSessions] = useState<Session[] | null>(null), [loading, setLoading] = useState(true);
  const [error, setError] = useState(""), [busy, setBusy] = useState(""), [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    void httpClient.get<Session[]>("/authorize/sessions").then((data) => { if (active) setSessions(data); })
      .catch((failure) => { if (active) setError(t(accountErrorKey(failure, "sessionsLoadFailed"))); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision, t]);
  const date = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : t("notRecorded");
  return <section className={`${panelClass} space-y-4`} aria-label={t("sessionsTitle")}>
    <h2 className="text-xl font-semibold">{t("sessionsTitle")}</h2>
    <p className="text-sm text-[var(--color-muted)]">{t("sessionsDescription")}</p>
    {loading ? <FormMessage message={t("loadingAccount")} /> : sessions?.length ? <ul className="divide-y divide-[var(--color-border)]">{sessions.map((session) => <li key={session.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
      <div className="space-y-1"><p className="font-medium">{t(session.current ? "currentSession" : "otherSession")}</p>
        <p className="text-sm text-[var(--color-muted)]">{t("lastActive")}: {date(session.lastActiveAt)}</p>
        <p className="text-sm text-[var(--color-muted)]">{t("expiresAt")}: {date(session.expiresAt)}</p></div>
      <button className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm hover:bg-[var(--color-background)] disabled:opacity-60" disabled={Boolean(busy)} onClick={async () => {
        setBusy(session.id); setError("");
        try {
          const result = await httpClient.delete<{ success: boolean }>(`/authorize/sessions/${encodeURIComponent(session.id)}`);
          if (result.success !== true) throw new Error("Unexpected revocation response");
          if (session.current) { useAuthStore.getState().logout(); router.replace("/login"); }
          else { setLoading(true); setRevision((value) => value + 1); }
        } catch (failure) { setError(t(accountErrorKey(failure, "sessionRevokeFailed"))); }
        finally { setBusy(""); }
      }}>{busy === session.id ? t("saving") : t(session.current ? "signOutCurrent" : "revokeSession")}</button>
    </li>)}</ul> : sessions ? <FormMessage message={t("noSessions")} /> : null}
    <FormMessage message={error} error />
    {error && <button className={buttonClass} disabled={loading} onClick={() => { setLoading(true); setError(""); setRevision((value) => value + 1); }}>{t("retry")}</button>}
  </section>;
}

export default function AccountPage() {
  const t = useTranslations("auth"), router = useRouter();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <div className="mx-auto max-w-5xl space-y-6 px-6 py-10">
    <header className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-3xl font-bold">{t("accountTitle")}</h1><p className="mt-2 text-[var(--color-muted)]">{t("accountDescription")}</p></div>
      <button className={buttonClass} disabled={busy} onClick={async () => {
        setBusy(true); setError("");
        try {
          const result = await httpClient.post<{ success: boolean }>("/authorize/logout", {});
          if (result.success !== true) throw new Error("Unexpected logout response");
          useAuthStore.getState().logout(); router.replace("/login");
        } catch (failure) { setError(t(accountErrorKey(failure, "logoutFailed"))); }
        finally { setBusy(false); }
      }}>{busy ? t("signingOut") : t("signOut")}</button></header>
    <FormMessage message={error} error />
    <AccountBillingLink />
    <AccountCreditsLink />
    <AccountFilesLink />
    <AvatarSection />
    <div className="grid items-start gap-6 lg:grid-cols-2"><ProfileSection /><PasswordSection /></div>
    <OAuthConnections />
    <AccountApiKeys />
    <SessionsSection />
  </div>;
}
