"use client";
import { useState } from "react";
import { useLocale } from "next-intl";
import { buttonClass, FormMessage } from "@/app/[locale]/account/_components/AccountForm";
import { accountSecurityApi } from "./api";
import { accountSecurityCopy } from "./copy";
import { securityFailure } from "./sign-in-flow";

export function formatSecurityDate(locale: string, value: string | null | undefined): string {
  return value && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat(locale, { dateStyle: "long", timeStyle: "short" }).format(new Date(value)) : "";
}

/**
 * Login answered 403 `ACCOUNT_DELETION_PENDING` after a correct password. Cancelling needs the same
 * username and password (public endpoint on the login budgets); `onCancelled` then retries the login.
 */
export function DeletionPendingNotice({ executeAfter, credentials, onCancelled, onBack }: {
  executeAfter: string;
  credentials: { username: string; password: string };
  onCancelled: () => Promise<void>;
  onBack: () => void;
}) {
  const locale = useLocale(), text = accountSecurityCopy(locale).deletionPending;
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const date = formatSecurityDate(locale, executeAfter);
  return <section className="space-y-4" aria-label={text.title}>
    <h2 className="text-lg font-semibold">{text.title}</h2>
    <p role="status" className="text-sm">{date ? text.body(date) : text.bodyNoDate}</p>
    <FormMessage message={error} error />
    <button type="button" className={`${buttonClass} w-full`} disabled={busy} onClick={async () => {
      setBusy(true); setError("");
      try {
        const result = await accountSecurityApi.cancelDeletion(credentials);
        if (result?.cancelled !== true) throw new Error("Unexpected cancel response");
        await onCancelled();
      } catch (failure) {
        setError(securityFailure(failure).code === "ACCOUNT_DELETION_NOT_PENDING" ? text.notPending : text.failed);
      } finally { setBusy(false); }
    }}>{busy ? text.cancelling : text.cancel}</button>
    <button type="button" className="w-full text-sm text-primary-500 underline-offset-4 hover:underline" disabled={busy} onClick={onBack}>{text.back}</button>
  </section>;
}

/** Mailed `#cancel-deletion=<ticket>` link: cancels only on explicit confirmation, never on page load. */
export function CancelDeletionByTicket({ ticket, onDone }: { ticket: string; onDone: () => void }) {
  const text = accountSecurityCopy(useLocale()).deletionPending;
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [done, setDone] = useState(false);
  if (done) return <div className="mb-4 space-y-3"><FormMessage message={text.ticketDone} />
    <button type="button" className="text-sm text-primary-500 underline-offset-4 hover:underline" onClick={onDone}>{text.back}</button></div>;
  return <section className="mb-6 space-y-3 rounded-lg border border-[var(--color-border)] p-4" aria-label={text.ticketTitle}>
    <h2 className="font-semibold">{text.ticketTitle}</h2>
    <p className="text-sm text-[var(--color-muted)]">{text.ticketBody}</p>
    <FormMessage message={error} error />
    <button type="button" className={`${buttonClass} w-full`} disabled={busy} onClick={async () => {
      setBusy(true); setError("");
      try {
        const result = await accountSecurityApi.cancelDeletion({ ticket });
        if (result?.cancelled !== true) throw new Error("Unexpected cancel response");
        setDone(true);
      } catch (failure) {
        setError(securityFailure(failure).code === "ACCOUNT_DELETION_NOT_PENDING" ? text.notPending : text.ticketInvalid);
      } finally { setBusy(false); }
    }}>{busy ? text.cancelling : text.ticketButton}</button>
  </section>;
}
