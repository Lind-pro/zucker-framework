"use client";
import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { accountPublicClient, httpClient } from "@/lib/http-client";
import { useAuthStore } from "@/lib/stores/auth-store";
import { accountErrorKey, type AccountIdentity } from "@/app/[locale]/account/_components/account-flow";
import { buttonClass, FormMessage, inputClass, panelClass } from "@/app/[locale]/account/_components/AccountForm";

/* Password change and session list, moved from /account to /account/security unchanged. */

export function PasswordSection() {
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
export function SessionsSection() {
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
