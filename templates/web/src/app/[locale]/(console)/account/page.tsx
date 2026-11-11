"use client";
import { AccountApiKeys } from "@/app/[locale]/account/_components/ApiKeys";
import { OAuthConnections } from "@/app/[locale]/account/_components/OAuthConnections";
import { AccountBillingLink } from "@/features/billing/AccountBillingLink";
import { AccountCreditsLink } from "@/features/credits/AccountCreditsLink";
import { AvatarSection } from "@/features/account-avatar/AvatarSection";
import { AccountFilesLink } from "@/features/files/AccountFilesLink";
import { SecurityLink } from "@/features/account-security/SecurityLink";
import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { httpClient } from "@/lib/http-client";
import { useAuthStore } from "@/lib/stores/auth-store";
import { accountErrorKey, accountPermissions, type AccountIdentity } from "@/app/[locale]/account/_components/account-flow";
import { buttonClass, FormMessage, inputClass, panelClass } from "@/app/[locale]/account/_components/AccountForm";

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
    <div className="grid items-start gap-6 lg:grid-cols-2"><ProfileSection /><SecurityLink /></div>
    <OAuthConnections />
    <div id="api-keys" className="scroll-mt-24"><AccountApiKeys /></div>
  </div>;
}
