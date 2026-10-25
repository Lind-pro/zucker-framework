"use client";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { AccountForm } from "../account/_components/AccountForm";
import { RequestAccountEmail } from "../account/_components/RequestAccountEmail";

export default function ForgotPasswordPage() {
  const t = useTranslations("auth");
  return <AccountForm title={t("forgotTitle")} description={t("forgotDescription")}>
    <RequestAccountEmail purpose="forgot-password" />
    <Link href="/login" className="mt-6 block text-center text-sm text-primary-500 hover:underline">{t("goLogin")}</Link>
  </AccountForm>;
}
