"use client";
import { useState } from "react";
import { useLocale } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Link, useRouter } from "@/i18n/navigation";
import { AccountForm, buttonClass, FormMessage } from "@/app/[locale]/account/_components/AccountForm";
import { accountReturnPath } from "@/app/[locale]/account/_components/account-flow";
import { establishSession } from "@/app/[locale]/account/_components/sign-in";
import { useEmailTicket } from "@/app/[locale]/account/_components/useEmailTicket";
import { accountSecurityApi } from "./api";
import { accountSecurityCopy } from "./copy";
import { formatSecurityDate } from "./DeletionPending";
import { TwoFactorStep } from "./TwoFactorStep";
import { deletionPendingUntil, securityFailure, signInResult } from "./sign-in-flow";

/**
 * Mailed `<locale>/magic-link#ticket=…`. The ticket is taken from the fragment and removed from the
 * address bar before any request, and is consumed only on an explicit click (mail scanners that open
 * links must not burn it). Enrolled accounts continue with the two-factor step.
 */
export function MagicLinkPage() {
  const locale = useLocale(), copy = accountSecurityCopy(locale), text = copy.magicLink;
  const router = useRouter(), search = useSearchParams(), ticket = useEmailTicket();
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [challenge, setChallenge] = useState("");
  const finish = async (token: string) => {
    await establishSession(token);
    router.replace(accountReturnPath(search.get("redirect")));
  };
  return <AccountForm title={text.pageTitle} description={text.pageDescription}>
    <div className="space-y-5">
      {ticket === null ? <FormMessage message={text.loading} />
        : challenge ? <TwoFactorStep challenge={challenge} onSignedIn={finish} onRestart={() => router.replace("/login")} />
        : ticket ? <button type="button" className={`${buttonClass} w-full`} disabled={busy || Boolean(error)} onClick={async () => {
          setBusy(true); setError("");
          try {
            const result = signInResult(await accountSecurityApi.consumeMagicLink(ticket));
            if (result.kind === "two-factor") setChallenge(result.challenge);
            else await finish(result.token);
          } catch (failure) {
            const pending = deletionPendingUntil(failure), { code } = securityFailure(failure);
            if (pending !== null) {
              const date = formatSecurityDate(locale, pending);
              setError(date ? copy.deletionPending.body(date) : copy.deletionPending.bodyNoDate);
            } else setError(code === "MAGIC_LINK_DISABLED" ? text.disabled : text.invalid);
          } finally { setBusy(false); }
        }}>{busy ? text.signingIn : text.pageButton}</button>
        : <FormMessage message={text.invalid} error />}
      <FormMessage message={error} error />
      {!challenge && <Link href="/login" className="block text-center text-sm text-primary-500 hover:underline">{text.goLogin}</Link>}
    </div>
  </AccountForm>;
}
