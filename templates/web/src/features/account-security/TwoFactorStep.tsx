"use client";
import { useEffect, useRef, useState } from "react";
import { useLocale } from "next-intl";
import { buttonClass, FormMessage, inputClass } from "@/app/[locale]/account/_components/AccountForm";
import { accountSecurityApi } from "./api";
import { accountSecurityCopy } from "./copy";
import { signInResult, twoFactorLoginBody, twoFactorStepFailure, type SecondFactor } from "./sign-in-flow";

/**
 * Second sign-in step after `{twoFactorRequired, challenge}` (password, magic link or OAuth). A wrong
 * code keeps the challenge usable (the user retries or switches factor); an expired/used challenge
 * sends the user back to the first step. `onSignedIn` receives the access token of the new session.
 */
export function TwoFactorStep({ challenge, onSignedIn, onRestart }: {
  challenge: string;
  onSignedIn: (token: string) => Promise<void>;
  onRestart: () => void;
}) {
  const text = accountSecurityCopy(useLocale()).twoFactor;
  const [factor, setFactor] = useState<SecondFactor>("code"), [value, setValue] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [expired, setExpired] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, [factor]);
  const id = factor === "code" ? "two-factor-code" : "two-factor-recovery";
  return <form className="space-y-4" aria-label={text.title} onSubmit={async event => {
    event.preventDefault(); setError("");
    const body = twoFactorLoginBody(challenge, factor, value);
    if (!body) { setError(factor === "code" ? text.malformedCode : text.malformedRecovery); return; }
    setBusy(true);
    try {
      const result = signInResult(await accountSecurityApi.loginTwoFactor(body));
      if (result.kind !== "session") throw new Error("Unexpected two-factor response");
      await onSignedIn(result.token);
    } catch (failure) {
      const key = twoFactorStepFailure(failure);
      if (key === "restart") setExpired(true);
      setError(text.errors[key]);
      setValue("");
    } finally { setBusy(false); }
  }}>
    <h2 className="text-lg font-semibold">{text.title}</h2>
    <p className="text-sm text-[var(--color-muted)]">{factor === "code" ? text.codeDescription : text.recoveryDescription}</p>
    <div><label htmlFor={id} className="mb-1.5 block text-sm font-medium">{factor === "code" ? text.codeLabel : text.recoveryLabel}</label>
      <input ref={input} id={id} name={factor === "code" ? "code" : "recoveryCode"} value={value} onChange={event => setValue(event.target.value)}
        autoComplete="one-time-code" inputMode={factor === "code" ? "numeric" : "text"} spellCheck={false} maxLength={factor === "code" ? 9 : 16}
        required disabled={busy || expired} className={`${inputClass} font-mono`} /></div>
    <FormMessage message={error} error />
    {expired
      ? <button type="button" className={`${buttonClass} w-full`} onClick={onRestart}>{text.startOver}</button>
      : <button type="submit" className={`${buttonClass} w-full`} disabled={busy}>{busy ? text.verifying : text.verify}</button>}
    <div className="flex flex-wrap justify-between gap-2 text-sm">
      <button type="button" className="text-primary-500 underline-offset-4 hover:underline disabled:opacity-60" disabled={busy || expired}
        onClick={() => { setFactor(factor === "code" ? "recovery" : "code"); setValue(""); setError(""); }}>
        {factor === "code" ? text.useRecovery : text.useCode}</button>
      {!expired && <button type="button" className="text-primary-500 underline-offset-4 hover:underline" disabled={busy} onClick={onRestart}>{text.startOver}</button>}
    </div>
  </form>;
}
