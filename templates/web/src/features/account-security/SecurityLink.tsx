"use client";
import { useLocale } from "next-intl";
import { Link } from "@/i18n/navigation";
import { buttonClass, panelClass } from "@/app/[locale]/account/_components/AccountForm";
import { accountSecurityCopy } from "./copy";

/** Keeps `/account#security` working: the anchor lands here and links to /account/security. */
export function SecurityLink() {
  const text = accountSecurityCopy(useLocale()).security;
  return <section id="security" className={`${panelClass} scroll-mt-24 space-y-4`} aria-label={text.title}>
    <h2 className="text-xl font-semibold">{text.title}</h2>
    <p className="text-sm text-[var(--color-muted)]">{text.linkBody}</p>
    <Link href="/account/security" className={`${buttonClass} inline-block`}>{text.linkAction}</Link>
  </section>;
}
