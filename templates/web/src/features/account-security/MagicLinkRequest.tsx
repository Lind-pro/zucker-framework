"use client";
import { useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { buttonClass, FormMessage, inputClass } from "@/app/[locale]/account/_components/AccountForm";
import { accountSecurityApi } from "./api";
import { accountSecurityCopy } from "./copy";
import { securityFailure } from "./sign-in-flow";

/**
 * "Email me a sign-in link", shown only when the public `account.magicLinkEnabled` policy is on. The
 * response is always neutral (`{accepted: true}`), so the page never reveals whether an account exists.
 */
export function MagicLinkRequest() {
  const text = accountSecurityCopy(useLocale()).magicLink;
  const [enabled, setEnabled] = useState(false), [open, setOpen] = useState(false);
  const [email, setEmail] = useState(""), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(""), [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void accountSecurityApi.publicPolicy().then(policy => { if (active) setEnabled(policy.magicLinkEnabled); }).catch(() => {});
    return () => { active = false; };
  }, []);
  if (!enabled) return null;
  if (!open) return <button type="button" className="mt-4 w-full rounded-lg border border-[var(--color-border)] px-4 py-2.5 font-medium"
    onClick={() => setOpen(true)}>{text.toggle}</button>;
  return <form className="mt-4 space-y-3 rounded-lg border border-[var(--color-border)] p-4" aria-label={text.toggle} onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try {
      const result = await accountSecurityApi.requestMagicLink(email.trim());
      if (result?.accepted !== true) throw new Error("Unexpected magic-link response");
      setMessage(text.sent);
    } catch (failure) {
      setError(securityFailure(failure).code === "MAGIC_LINK_DISABLED" ? text.disabled : text.failed);
    } finally { setBusy(false); }
  }}>
    <div><label htmlFor="magic-link-email" className="mb-1.5 block text-sm font-medium">{text.email}</label>
      <input id="magic-link-email" type="email" autoComplete="email" required maxLength={254} value={email} disabled={busy}
        onChange={event => setEmail(event.target.value)} className={inputClass} /></div>
    <button type="submit" className={`${buttonClass} w-full`} disabled={busy}>{busy ? text.sending : text.send}</button>
    <FormMessage message={message} />
    <FormMessage message={error} error />
  </form>;
}
