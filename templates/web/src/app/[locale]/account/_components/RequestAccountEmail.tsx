"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { accountPublicClient } from "@/lib/http-client";
import { accountErrorKey } from "./account-flow";
import { buttonClass, FormMessage, inputClass } from "./AccountForm";

export function RequestAccountEmail({ purpose }: { purpose: "verification" | "forgot-password" }) {
  const t = useTranslations("auth");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  return <form className="space-y-4" onSubmit={async (event) => {
    event.preventDefault(); setBusy(true); setMessage(""); setFailed(false);
    try {
      const result = await accountPublicClient.post<{ accepted: boolean }>(`/authorize/${purpose}`, { email });
      if (result.accepted !== true) throw new Error("Unexpected account response");
      setMessage(t("emailAccepted"));
    } catch (error) { setFailed(true); setMessage(t(accountErrorKey(error, "requestFailed"))); }
    finally { setBusy(false); }
  }}>
    <div><label className="block text-sm font-medium mb-1.5" htmlFor={`email-${purpose}`}>{t("email")}</label>
      <input id={`email-${purpose}`} name="email" type="email" autoComplete="email" required maxLength={254} className={inputClass} value={email} onChange={(event) => setEmail(event.target.value)} /></div>
    <FormMessage message={message} error={failed} />
    <button className={`${buttonClass} w-full`} type="submit" disabled={busy}>{busy ? t("sending") : t(purpose === "verification" ? "resendVerification" : "sendResetLink")}</button>
  </form>;
}
