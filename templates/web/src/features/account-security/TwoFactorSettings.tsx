"use client";
import { useEffect, useRef, useState } from "react";
import { useLocale } from "next-intl";
import { buttonClass, FormMessage, inputClass, panelClass } from "@/app/[locale]/account/_components/AccountForm";
import { accountSecurityApi, type TwoFactorStatus } from "./api";
import { accountSecurityCopy, type AccountSecurityCopy } from "./copy";
import { formatSecurityDate } from "./DeletionPending";
import { QrCode } from "./QrCode";
import { factorBody, groupSecret, normalizeTotpInput, recoveryCodesFile, safeOtpauthUri, twoFactorSettingsFailure, type SecondFactor } from "./sign-in-flow";

const secondaryClass = "rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm disabled:opacity-60";

/**
 * Recovery codes are shown exactly once (component state only, never stored); copy and download are
 * offered until the user dismisses them.
 */
function RecoveryCodes({ codes, account, text, onDone }: { codes: string[]; account: string; text: AccountSecurityCopy["enrol"]; onDone: () => void }) {
  const [copied, setCopied] = useState(false), [error, setError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return <div className="space-y-3 rounded-lg border border-primary-500 p-4">
    <h3 ref={heading} tabIndex={-1} className="font-semibold">{text.codesTitle}</h3>
    <p className="text-sm text-[var(--color-muted)]">{text.codesHelp}</p>
    <ul aria-label={text.codesTitle} className="grid grid-cols-2 gap-2 font-mono text-sm">{codes.map(code => <li key={code}>{code}</li>)}</ul>
    <div className="flex flex-wrap gap-2">
      <button type="button" className={secondaryClass} onClick={async () => {
        try { await navigator.clipboard.writeText(codes.join("\n")); setCopied(true); setError(""); } catch { setError(text.copyFailed); }
      }}>{copied ? text.copied : text.copy}</button>
      <button type="button" className={secondaryClass} onClick={() => {
        const url = URL.createObjectURL(new Blob([recoveryCodesFile(codes, account, new Date())], { type: "text/plain" }));
        const link = document.createElement("a");
        link.href = url; link.download = "recovery-codes.txt"; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }}>{text.download}</button>
      <button type="button" className={buttonClass} onClick={onDone}>{text.saved}</button>
    </div>
    <FormMessage message={error} error />
  </div>;
}

function PasswordField({ id, value, onChange, disabled, text }: { id: string; value: string; onChange: (value: string) => void; disabled: boolean; text: AccountSecurityCopy["enrol"] }) {
  return <div><label htmlFor={id} className="mb-1.5 block text-sm font-medium">{text.password}</label>
    <input id={id} type="password" autoComplete="current-password" maxLength={128} value={value} disabled={disabled}
      onChange={event => onChange(event.target.value)} className={inputClass} aria-describedby={`${id}-hint`} />
    <p id={`${id}-hint`} className="mt-1 text-xs text-[var(--color-muted)]">{text.passwordHint}</p></div>;
}

type Mode =
  | { kind: "idle" }
  | { kind: "enrol" }
  | { kind: "secret"; secret: string; uri: string | null }
  | { kind: "codes"; codes: string[] }
  | { kind: "disable" }
  | { kind: "regenerate" };

/** Two-step verification: enrol (key and setup link, confirm code), recovery codes, disable. */
export function TwoFactorSettings({ account }: { account: string }) {
  const locale = useLocale(), text = accountSecurityCopy(locale).enrol, title = accountSecurityCopy(locale).twoFactor.title;
  const [status, setStatus] = useState<TwoFactorStatus | null>(null), [loadFailed, setLoadFailed] = useState(false), [revision, setRevision] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [password, setPassword] = useState(""), [code, setCode] = useState(""), [factor, setFactor] = useState<SecondFactor>("code");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    void accountSecurityApi.status().then(value => { if (active) { setStatus(value); setLoadFailed(false); } })
      .catch(() => { if (active) setLoadFailed(true); });
    return () => { active = false; };
  }, [revision]);
  const reset = (next: Mode = { kind: "idle" }) => { setMode(next); setPassword(""); setCode(""); setFactor("code"); setError(""); };
  const reload = () => { setRevision(value => value + 1); };
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (failure) {
      const key = twoFactorSettingsFailure(failure);
      setError(text.errors[key]);
      if (key === "alreadyEnabled" || key === "notEnabled" || key === "notPending") reload();
    } finally { setBusy(false); }
  };
  const header = <><h2 className="text-xl font-semibold">{title}</h2><p className="text-sm text-[var(--color-muted)]">{text.description}</p></>;
  if (!status) return <section className={`${panelClass} space-y-4`} aria-label={title}>{header}
    {loadFailed ? <><FormMessage message={text.loadFailed} error /><button type="button" className={buttonClass} onClick={reload}>{text.retry}</button></>
      : <FormMessage message={text.loading} />}
  </section>;

  const summary = status.status === "active"
    ? `${text.activeSince(formatSecurityDate(locale, status.confirmedAt) || "—")} · ${text.remaining(status.recoveryCodesRemaining)}`
    : status.status === "pending" ? text.pending : text.off;
  const canEnrol = status.available && status.enrolmentAllowed;
  return <section className={`${panelClass} space-y-4`} aria-label={title}>
    {header}
    <p className="text-sm font-medium" data-two-factor-status={status.status}>{summary}</p>
    <FormMessage message={notice} />

    {mode.kind === "codes" && <RecoveryCodes codes={mode.codes} account={account} text={text} onDone={() => reset()} />}

    {mode.kind === "idle" && status.status !== "active" && (!status.available ? <FormMessage message={text.unavailable} />
      : !status.enrolmentAllowed ? <FormMessage message={text.notOffered} />
      : <button type="button" className={buttonClass} onClick={() => reset({ kind: "enrol" })}>{text.setUp}</button>)}

    {mode.kind === "enrol" && canEnrol && <form className="space-y-3" onSubmit={event => {
      event.preventDefault();
      void run(async () => {
        const result = await accountSecurityApi.enrol(password);
        if (typeof result?.secret !== "string" || !result.secret) throw new Error("Unexpected enrolment response");
        reset({ kind: "secret", secret: result.secret, uri: safeOtpauthUri(result.otpauthUri) });
      });
    }}>
      <PasswordField id="two-factor-enrol-password" value={password} onChange={setPassword} disabled={busy} text={text} />
      <div className="flex flex-wrap gap-2"><button type="submit" className={buttonClass} disabled={busy}>{busy ? text.working : text.continue}</button>
        <button type="button" className={secondaryClass} disabled={busy} onClick={() => reset()}>{text.cancel}</button></div>
    </form>}

    {mode.kind === "secret" && <form className="space-y-3" onSubmit={event => {
      event.preventDefault();
      const value = normalizeTotpInput(code);
      if (!value) { setError(text.errors.codeInvalid); return; }
      void run(async () => {
        const result = await accountSecurityApi.confirm(value);
        if (!Array.isArray(result?.recoveryCodes) || !result.recoveryCodes.length) throw new Error("Unexpected confirmation response");
        reset({ kind: "codes", codes: result.recoveryCodes.filter(item => typeof item === "string") });
        setNotice(text.enabled); reload();
      });
    }}>
      <h3 className="font-semibold">{text.secretTitle}</h3>
      <p className="text-sm text-[var(--color-muted)]">{text.secretHelp}</p>
      {/* Generated locally from the otpauth URI; the setup key and link below stay as the fallback. */}
      {mode.uri && <QrCode value={mode.uri} label={text.qrLabel} />}
      <div><label htmlFor="two-factor-secret" className="mb-1.5 block text-sm font-medium">{text.secretLabel}</label>
        <input id="two-factor-secret" readOnly value={groupSecret(mode.secret)} spellCheck={false} autoComplete="off" className={`${inputClass} font-mono`}
          onFocus={event => event.currentTarget.select()} /></div>
      {mode.uri && <div className="space-y-2"><label htmlFor="two-factor-uri" className="block text-sm font-medium">{text.uriLabel}</label>
        <textarea id="two-factor-uri" readOnly rows={3} value={mode.uri} spellCheck={false} autoComplete="off"
          className="block w-full resize-none rounded-lg bg-[var(--color-background)] p-3 font-mono text-xs break-all" />
        <a href={mode.uri} className="text-sm text-primary-500 underline-offset-4 hover:underline">{text.openInApp}</a></div>}
      <div><label htmlFor="two-factor-confirm" className="mb-1.5 block text-sm font-medium">{text.confirmLabel}</label>
        <input id="two-factor-confirm" value={code} onChange={event => setCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code"
          maxLength={9} required disabled={busy} className={`${inputClass} font-mono`} /></div>
      <div className="flex flex-wrap gap-2"><button type="submit" className={buttonClass} disabled={busy}>{busy ? text.working : text.confirm}</button>
        <button type="button" className={secondaryClass} disabled={busy} onClick={() => { reset(); reload(); }}>{text.cancel}</button></div>
    </form>}

    {status.status === "active" && mode.kind === "idle" && <div className="flex flex-wrap gap-2">
      <button type="button" className={secondaryClass} onClick={() => reset({ kind: "regenerate" })}>{text.regenerateTitle}</button>
      <button type="button" className={secondaryClass} onClick={() => reset({ kind: "disable" })}>{text.disableTitle}</button>
    </div>}

    {(mode.kind === "disable" || mode.kind === "regenerate") && <form className="space-y-3 rounded-lg border border-[var(--color-border)] p-4"
      aria-label={mode.kind === "disable" ? text.disableTitle : text.regenerateTitle} onSubmit={event => {
        event.preventDefault();
        const body = factorBody(mode.kind === "regenerate" ? "code" : factor, code, password);
        if (!body) { setError(text.errors.malformed); return; }
        void run(async () => {
          if (mode.kind === "disable") {
            const result = await accountSecurityApi.disable(body);
            if (result?.success !== true) throw new Error("Unexpected disable response");
            reset(); setNotice(text.disabledDone); reload();
          } else {
            const result = await accountSecurityApi.regenerate(body);
            if (!Array.isArray(result?.recoveryCodes) || !result.recoveryCodes.length) throw new Error("Unexpected recovery-code response");
            reset({ kind: "codes", codes: result.recoveryCodes.filter(item => typeof item === "string") }); reload();
          }
        });
      }}>
      <h3 className="font-semibold">{mode.kind === "disable" ? text.disableTitle : text.regenerateTitle}</h3>
      {mode.kind === "regenerate" && <p className="text-sm text-[var(--color-muted)]">{text.regenerateHelp}</p>}
      <PasswordField id="two-factor-manage-password" value={password} onChange={setPassword} disabled={busy} text={text} />
      {mode.kind === "disable" && <fieldset className="flex flex-wrap gap-4 text-sm"><legend className="sr-only">{text.factorCode}</legend>
        {(["code", "recovery"] as const).map(value => <label key={value} className="flex items-center gap-2">
          <input type="radio" name="two-factor-factor" checked={factor === value} disabled={busy} onChange={() => { setFactor(value); setCode(""); }} />
          {value === "code" ? text.factorCode : text.factorRecovery}</label>)}
      </fieldset>}
      <div><label htmlFor="two-factor-manage-code" className="mb-1.5 block text-sm font-medium">{factor === "code" || mode.kind === "regenerate" ? text.factorCode : text.factorRecovery}</label>
        <input id="two-factor-manage-code" value={code} onChange={event => setCode(event.target.value)} autoComplete="one-time-code" required disabled={busy}
          inputMode={factor === "code" || mode.kind === "regenerate" ? "numeric" : "text"} maxLength={16} className={`${inputClass} font-mono`} /></div>
      <div className="flex flex-wrap gap-2"><button type="submit" className={buttonClass} disabled={busy}>
        {busy ? text.working : mode.kind === "disable" ? text.disable : text.regenerate}</button>
        <button type="button" className={secondaryClass} disabled={busy} onClick={() => reset()}>{text.cancel}</button></div>
    </form>}

    <FormMessage message={error} error />
  </section>;
}
