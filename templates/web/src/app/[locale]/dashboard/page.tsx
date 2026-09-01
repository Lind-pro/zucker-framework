"use client";

import { useTranslations } from "next-intl";
import { LayoutDashboard, Activity, Zap } from "lucide-react";

export default function DashboardPage() {
  const t = useTranslations("dashboard");

  return (
    <div className="max-w-6xl mx-auto px-6 py-12">
      <h1 className="text-3xl font-bold mb-2">{t("title")}</h1>
      <p className="text-[var(--color-muted)] mb-8">{t("welcome")}</p>

      <div className="grid md:grid-cols-3 gap-6 mb-8">
        {[
          { icon: LayoutDashboard, label: t("overview"), value: "--" },
          { icon: Activity, label: t("recentActivity"), value: "--" },
          { icon: Zap, label: t("quickActions"), value: "--" },
        ].map((card) => (
          <div
            key={card.label}
            className="p-6 rounded-xl bg-[var(--color-card)] border border-[var(--color-border)]"
          >
            <card.icon className="w-8 h-8 text-primary-500 mb-3" />
            <p className="text-sm text-[var(--color-muted)]">{card.label}</p>
            <p className="text-2xl font-bold mt-1">{card.value}</p>
          </div>
        ))}
      </div>

      <div className="p-8 rounded-xl bg-[var(--color-card)] border border-[var(--color-border)] text-center">
        <p className="text-[var(--color-muted)]">{t("noData")}</p>
      </div>
    </div>
  );
}
