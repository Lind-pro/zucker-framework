"use client";
import { useEffect, useRef, useState } from "react";
import { useLocale } from "next-intl";
import { buttonClass, FormMessage, inputClass, panelClass } from "@/app/[locale]/account/_components/AccountForm";
import { accountSecurityApi } from "./api";
import { accountSecurityCopy } from "./copy";
import { deletionFailure, type AccountSecurityPolicy } from "./sign-in-flow";

const secondaryClass = "rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm disabled:opacity-60";

/**
 * Self-service deletion with the policy's grace period. The dialog asks the user to type the username
 * (the server compares it too). On success the server has ended every session and revoked API keys;
 * `onScheduled` replaces the page so nothing else keeps calling the API.
 */
export function DeleteAccount({ username, policy, onScheduled }: { username: string; policy: AccountSecurityPolicy; onScheduled: (executeAfter: string) => void }) {
  const text = accountSecurityCopy(useLocale()).deletion;
  const dialog = useRef<HTMLDialogElement>(null);
  const [confirm, setConfirm] = useState(""), [reason, setReason] = useState(""), [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => () => dialog.current?.close(), []);
  if (!policy.deletionEnabled) return <section className={`${panelClass} space-y-3`} aria-label={text.title}>
    <h2 className="text-xl font-semibold">{text.title}</h2><p className="text-sm text-[var(--color-muted)]">{text.unavailable}</p>
  </section>;
  const close = () => { dialog.current?.close(); setConfirm(""); setReason(""); setPassword(""); setError(""); };
  return <section className={`${panelClass} space-y-3 border-red-500/40`} aria-label={text.title}>
    <h2 className="text-xl font-semibold">{text.title}</h2>
    <p className="text-sm" data-grace-days={policy.deletionGraceDays}>{text.description(policy.deletionGraceDays)}</p>
    <p className="text-sm text-[var(--color-muted)]">{text.retained}</p>
    <button type="button" className="rounded-lg bg-red-600 px-4 py-2.5 font-medium text-white hover:bg-red-700 disabled:opacity-60"
      onClick={() => dialog.current?.showModal()}>{text.open}</button>
    <dialog ref={dialog} aria-labelledby="delete-account-title" onCancel={close}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-6 text-[var(--color-foreground)] backdrop:bg-black/50">
      <form className="space-y-4" onSubmit={async event => {
        event.preventDefault(); setError("");
        if (confirm.trim() !== username) { setError(text.errors.mismatch); return; }
        setBusy(true);
        try {
          const result = await accountSecurityApi.scheduleDeletion({ confirm: confirm.trim(), ...(reason.trim() ? { reason: reason.trim() } : {}), ...(password ? { password } : {}) });
          if (result?.scheduled !== true) throw new Error("Unexpected deletion response");
          dialog.current?.close();
          onScheduled(typeof result.executeAfter === "string" ? result.executeAfter : "");
        } catch (failure) { setError(text.errors[deletionFailure(failure)]); }
        finally { setBusy(false); }
      }}>
        <h2 id="delete-account-title" className="text-xl font-semibold">{text.dialogTitle}</h2>
        <p className="text-sm">{text.description(policy.deletionGraceDays)}</p>
        <div><label htmlFor="delete-account-confirm" className="mb-1.5 block text-sm font-medium">{text.confirmLabel(username)}</label>
          <input id="delete-account-confirm" value={confirm} onChange={event => setConfirm(event.target.value)} autoComplete="off" spellCheck={false}
            required maxLength={128} disabled={busy} className={inputClass} /></div>
        <div><label htmlFor="delete-account-reason" className="mb-1.5 block text-sm font-medium">{text.reason}</label>
          <textarea id="delete-account-reason" value={reason} onChange={event => setReason(event.target.value)} maxLength={500} rows={3} disabled={busy} className={inputClass} /></div>
        <div><label htmlFor="delete-account-password" className="mb-1.5 block text-sm font-medium">{text.password}</label>
          <input id="delete-account-password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)}
            maxLength={128} disabled={busy} className={inputClass} aria-describedby="delete-account-password-hint" />
          <p id="delete-account-password-hint" className="mt-1 text-xs text-[var(--color-muted)]">{text.passwordHint}</p></div>
        <FormMessage message={error} error />
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={secondaryClass} disabled={busy} onClick={close}>{text.cancel}</button>
          <button type="submit" className={`${buttonClass} !bg-red-600 hover:!bg-red-700`} disabled={busy || confirm.trim() !== username}>{busy ? text.working : text.confirm}</button>
        </div>
      </form>
    </dialog>
  </section>;
}
