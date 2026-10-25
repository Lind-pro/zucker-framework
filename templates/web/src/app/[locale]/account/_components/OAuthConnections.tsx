"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { httpClient } from "@/lib/http-client";
import { useAuthStore } from "@/lib/stores/auth-store";
import { FormMessage, panelClass } from "./AccountForm";
import { oauthProviders, type OAuthProvider } from "./oauth-client";
import { SocialSignIn } from "./SocialSignIn";

interface Connection { provider: string; displayName?: string; email?: string }
export function OAuthConnections() {
  const t = useTranslations("auth"), router = useRouter();
  const [providers, setProviders] = useState<OAuthProvider[]>([]), [connections, setConnections] = useState<Connection[]>([]);
  const [error, setError] = useState(""), [busy, setBusy] = useState(""), [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    let active = true;
    void Promise.allSettled([oauthProviders(), httpClient.get<{ connections: Connection[] }>("/authorize/oauth/connections")]).then(([available, linked]) => {
      if (!active) return;
      const enabled = available.status === "fulfilled" ? available.value : [];
      setProviders(enabled);
      if (linked.status === "fulfilled" && Array.isArray(linked.value.connections)) { setConnections(linked.value.connections); setError(""); }
      else if (enabled.length) setError(t("oauthConnectionsFailed"));
    });
    return () => { active = false; };
  }, [revision, t]);
  const unlinked = useMemo(() => providers.filter(provider => !connections.some(connection => connection.provider === provider.id)), [providers, connections]);
  if (!providers.length && !connections.length) return null;
  return <section className={`${panelClass} space-y-4`} aria-label={t("connectedAccounts")}>
    <h2 className="text-xl font-semibold">{t("connectedAccounts")}</h2>
    <p className="text-sm text-[var(--color-muted)]">{t("connectedAccountsDescription")}</p>
    {connections.length ? <ul className="divide-y divide-[var(--color-border)]">{connections.map(connection => <li key={connection.provider} className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div><p className="font-medium">{connection.provider === "google" ? "Google" : connection.provider === "github" ? "GitHub" : connection.provider}</p>
        <p className="break-all text-sm text-[var(--color-muted)]">{connection.email || connection.displayName || t("providerIdentityVerified")}</p></div>
      <button type="button" className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm disabled:opacity-60" disabled={Boolean(busy)} onClick={async () => {
        setBusy(connection.provider); setError("");
        try {
          const result = await httpClient.delete<{ success: boolean; signedOut?: boolean }>(`/authorize/oauth/connections/${encodeURIComponent(connection.provider)}`);
          if (result.success !== true) throw new Error("Disconnect was not confirmed");
          if (result.signedOut) { useAuthStore.getState().logout(); router.replace("/login"); }
          else reload();
        } catch { setError(t("oauthUnlinkFailed")); }
        finally { setBusy(""); }
      }}>{t("disconnectProvider")}</button>
    </li>)}</ul> : !error ? <p className="text-sm text-[var(--color-muted)]">{t("noConnectedAccounts")}</p> : null}
    <FormMessage message={error} error />
    {error && <button type="button" className="text-sm underline" onClick={reload}>{t("retry")}</button>}
    <SocialSignIn purpose="link" configured={unlinked} onLinked={reload} />
  </section>;
}
