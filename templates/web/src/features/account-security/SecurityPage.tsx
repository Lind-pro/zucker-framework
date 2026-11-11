"use client";
import { useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { Link } from "@/i18n/navigation";
import { httpClient } from "@/lib/http-client";
import { useAuthStore } from "@/lib/stores/auth-store";
import { FormMessage, panelClass } from "@/app/[locale]/account/_components/AccountForm";
import type { AccountIdentity } from "@/app/[locale]/account/_components/account-flow";
import { accountSecurityApi } from "./api";
import { accountSecurityCopy } from "./copy";
import { DeleteAccount } from "./DeleteAccount";
import { formatSecurityDate } from "./DeletionPending";
import { PasswordSection, SessionsSection } from "./PasswordAndSessions";
import { TwoFactorSettings } from "./TwoFactorSettings";
import { DEFAULT_ACCOUNT_SECURITY_POLICY, type AccountSecurityPolicy } from "./sign-in-flow";

/** /account/security: password, two-step verification, sessions and account deletion. */
export function SecurityPage() {
  const locale = useLocale(), copy = accountSecurityCopy(locale);
  const storedName = useAuthStore(state => state.user?.username);
  const [username, setUsername] = useState<string>("");
  const [policy, setPolicy] = useState<AccountSecurityPolicy>(DEFAULT_ACCOUNT_SECURITY_POLICY);
  const [scheduled, setScheduled] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    // The confirmation must match the server's username, so read it from /me rather than trusting cached state.
    void httpClient.get<AccountIdentity>("/authorize/me").then(me => { if (active && typeof me?.username === "string") setUsername(me.username); }).catch(() => {});
    void accountSecurityApi.publicPolicy().then(value => { if (active) setPolicy(value); }).catch(() => {});
    return () => { active = false; };
  }, []);
  if (scheduled !== null) {
    const date = formatSecurityDate(locale, scheduled);
    return <div className="mx-auto max-w-3xl space-y-6 px-6 py-10">
      <section className={`${panelClass} space-y-4`} aria-label={copy.deletion.title}>
        <h1 className="text-2xl font-bold">{copy.deletion.title}</h1>
        <FormMessage message={copy.deletion.scheduled(date || "—")} />
        <Link href="/" className="text-primary-500 underline-offset-4 hover:underline">{copy.deletion.goHome}</Link>
      </section>
    </div>;
  }
  const account = username || (typeof storedName === "string" ? storedName : "");
  return <div className="mx-auto max-w-5xl space-y-6 px-6 py-10">
    <header><h1 className="text-3xl font-bold">{copy.security.title}</h1><p className="mt-2 text-[var(--color-muted)]">{copy.security.description}</p>
      <Link href="/account" className="mt-2 inline-block text-sm text-primary-500 underline-offset-4 hover:underline">{copy.security.back}</Link></header>
    <PasswordSection />
    <TwoFactorSettings account={account} />
    <SessionsSection />
    {username && <DeleteAccount username={username} policy={policy} onScheduled={executeAfter => {
      // The server cleared the session cookie and ended every session; drop the local copy too.
      useAuthStore.getState().logout();
      setScheduled(executeAfter);
    }} />}
  </div>;
}
