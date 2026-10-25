"use client";
import { useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { httpClient } from "@/lib/http-client";
import { useAuthStore } from "@/lib/stores/auth-store";
import { buttonClass, FormMessage, inputClass, panelClass } from "./AccountForm";

interface AccountApiKey {
  id: string; name: string; keyPrefix: string; scopes: string[]; expiresAt: string | null;
  createdAt: string; lastUsedAt?: string | null; usageCount?: number; isActive?: boolean; canRename?: boolean;
}
const canRename = (key: AccountApiKey) => key.canRename !== false && key.isActive !== false
  && (!key.expiresAt || Date.parse(key.expiresAt) > Date.now());

export function AccountApiKeys() {
  const owner = useAuthStore(state => state.user?.id), t = useTranslations("apiKeys");
  if (typeof owner !== "string" || !owner) return <section className={`${panelClass} space-y-4`} aria-label={t("title")}>
    <h2 className="text-xl font-semibold">{t("title")}</h2><FormMessage message={t("loading")} />
  </section>;
  // Mount only after identity is known; a late /me must not discard a freshly-created secret.
  return <ApiKeysPanel key={owner} />;
}

function ApiKeysPanel() {
  const t = useTranslations("apiKeys"), locale = useLocale();
  const [keys, setKeys] = useState<AccountApiKey[]>([]), [loading, setLoading] = useState(true);
  const [name, setName] = useState(""), [days, setDays] = useState("30"), [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [loadFailed, setLoadFailed] = useState(false);
  const [secret, setSecret] = useState(""), [createdId, setCreatedId] = useState(""), [copied, setCopied] = useState(false);
  const [editingId, setEditingId] = useState(""), [editingName, setEditingName] = useState("");
  const renameInput = useRef<HTMLInputElement>(null);
  const copyButton = useRef<HTMLButtonElement>(null), nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let active = true;
    void httpClient.get<{ apiKeys: AccountApiKey[] }>("/authorize/api-keys").then(result => {
      if (!active) return;
      if (!Array.isArray(result.apiKeys)) throw new Error("Invalid key list");
      setKeys(result.apiKeys); setLoadFailed(false);
    }).catch(() => { if (active) { setLoadFailed(true); setError(t("loadFailed")); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision, t]);
  useEffect(() => { if (secret) copyButton.current?.focus(); }, [secret]);
  useEffect(() => { if (editingId) renameInput.current?.focus(); }, [editingId]);
  const refresh = () => { setLoading(true); setError(""); setRevision(value => value + 1); };
  const date = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(value)) : t("notUsed");
  return <section className={`${panelClass} space-y-4`} aria-label={t("title")}>
    <h2 className="text-xl font-semibold">{t("title")}</h2>
    <p className="text-sm text-[var(--color-muted)]">{t("description")}</p>
    <p className="text-sm"><code>GET /api/v1/account</code> · {t("readScope")}</p>
    {secret && <div className="space-y-3 rounded-lg border border-primary-500 p-4">
      <FormMessage message={t("createdOnce")} />
      <label htmlFor="created-api-key" className="block text-sm font-medium">{t("newKeyTitle")}</label>
      <textarea id="created-api-key" value={secret} readOnly rows={2} spellCheck={false} autoComplete="off" className="block w-full resize-none rounded-lg bg-[var(--color-background)] p-3 font-mono text-sm" />
      <div className="flex flex-wrap gap-3">
        <button ref={copyButton} type="button" className={buttonClass} onClick={async () => {
          try { await navigator.clipboard.writeText(secret); setCopied(true); setError(""); }
          catch { setError(t("copyFailed")); }
        }}>{t(copied ? "copied" : "copy")}</button>
        <button type="button" className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm" onClick={() => {
          setSecret(""); setCreatedId(""); setCopied(false); requestAnimationFrame(() => nameInput.current?.focus());
        }}>{t("dismissSecret")}</button>
      </div>
    </div>}
    <form className="grid items-end gap-4 sm:grid-cols-[minmax(0,1fr)_auto_auto]" onSubmit={async event => {
      event.preventDefault(); setBusy("create"); setError("");
      try {
        const result = await httpClient.post<{ apiKey: AccountApiKey; secretKey: string }>("/authorize/api-keys", {
          name: name.trim(), expiresInDays: Number(days), scopes: ["account:read"],
        });
        if (!result.apiKey?.id || typeof result.secretKey !== "string" || !result.secretKey) throw new Error("Missing key creation result");
        setSecret(result.secretKey); setCreatedId(result.apiKey.id); setCopied(false); setName("");
        setKeys(current => [result.apiKey, ...current]); refresh();
      } catch { setError(t("createFailed")); }
      finally { setBusy(""); }
    }}>
      <div><label htmlFor="api-key-name" className="mb-1.5 block text-sm font-medium">{t("name")}</label>
        <input ref={nameInput} id="api-key-name" value={name} onChange={event => setName(event.target.value)} maxLength={80} required autoComplete="off"
          disabled={Boolean(busy || secret)} className={inputClass} /></div>
      <div><label htmlFor="api-key-expiry" className="mb-1.5 block text-sm font-medium">{t("expiry")}</label>
        <select id="api-key-expiry" value={days} onChange={event => setDays(event.target.value)} disabled={Boolean(busy || secret)} className={inputClass}>
          {[7, 30, 90, 365].map(value => <option key={value} value={value}>{t("days", { days: value })}</option>)}
        </select></div>
      <button type="submit" className={buttonClass} disabled={Boolean(busy || secret)}>{t(busy === "create" ? "creating" : "create")}</button>
    </form>
    <FormMessage message={error} error />
    {loadFailed && <button type="button" className={buttonClass} disabled={loading} onClick={refresh}>{t("retry")}</button>}
    {loading ? <FormMessage message={t("loading")} /> : keys.length ? <ul className="divide-y divide-[var(--color-border)]">{keys.map(key => <li key={key.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
      <div className="min-w-0 space-y-1"><p className="break-all font-medium">{key.name}</p><p className="break-all font-mono text-sm text-[var(--color-muted)]">{key.keyPrefix}</p>
        <p className="text-sm text-[var(--color-muted)]">{t("expiresAt", { date: date(key.expiresAt) })} · {t("lastUsed", { date: date(key.lastUsedAt) })}</p>
        <p className="text-sm text-[var(--color-muted)]">{key.scopes.join(", ")} · {t("requests", { count: key.usageCount ?? 0 })}</p>
      </div>
      <div className="flex flex-wrap gap-2"><button type="button" className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm disabled:opacity-60"
        disabled={Boolean(busy) || !canRename(key)} aria-label={t("renameNamed", { name: key.name })} onClick={() => {
          setEditingId(key.id); setEditingName(key.name); setError("");
        }}>{t("rename")}</button>
      <button type="button" className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm disabled:opacity-60" disabled={Boolean(busy)}
        aria-label={t("revokeNamed", { name: key.name })} onClick={async () => {
          setBusy(key.id); setError("");
          try {
            const result = await httpClient.delete<{ success: boolean }>(`/authorize/api-keys/${encodeURIComponent(key.id)}`);
            if (result.success !== true) throw new Error("Revocation was not confirmed");
            setKeys(current => current.filter(item => item.id !== key.id));
            if (editingId === key.id) { setEditingId(""); setEditingName(""); }
            // A revoked newly-created key must not remain copyable.
            if (createdId === key.id) { setSecret(""); setCreatedId(""); }
          } catch { setError(t("revokeFailed")); }
          finally { setBusy(""); }
        }}>{t("revoke")}</button></div>
      {editingId === key.id && <form className="grid w-full items-end gap-3 rounded-lg border border-[var(--color-border)] p-4 sm:grid-cols-[1fr_auto_auto]" onSubmit={async event => {
        event.preventDefault(); setBusy(`rename:${key.id}`); setError("");
        try {
          const result = await httpClient.patch<{ id: string; name: string }>(`/authorize/api-keys/${encodeURIComponent(key.id)}`, { name: editingName.trim() });
          if (result.id !== key.id || result.name !== editingName.trim()) throw new Error("Rename was not confirmed");
          setKeys(current => current.map(item => item.id === key.id ? { ...item, name: result.name } : item));
          setEditingId(""); setEditingName("");
        } catch (failure) {
          const unavailable = !!failure && typeof failure === "object" && "status" in failure && failure.status === 404;
          if (unavailable) setKeys(current => current.map(item => item.id === key.id ? { ...item, canRename: false } : item));
          setError(t(unavailable ? "renameUnavailable" : "renameFailed"));
        } finally { setBusy(""); }
      }}>
        <div><label htmlFor={`rename-key-${key.id}`} className="mb-1.5 block text-sm font-medium">{t("newName")}</label>
          <input ref={renameInput} id={`rename-key-${key.id}`} value={editingName} onChange={event => setEditingName(event.target.value)} required maxLength={80}
            autoComplete="off" disabled={Boolean(busy) || !canRename(key)} className={inputClass} /></div>
        <button type="submit" className={buttonClass} disabled={Boolean(busy) || !canRename(key)}>{t(busy === `rename:${key.id}` ? "renaming" : "saveName")}</button>
        <button type="button" className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm" disabled={Boolean(busy)} onClick={() => { setEditingId(""); setEditingName(""); setError(""); }}>{t("cancelRename")}</button>
      </form>}
    </li>)}</ul> : !loadFailed ? <p className="text-sm text-[var(--color-muted)]">{t("empty")}</p> : null}
  </section>;
}
