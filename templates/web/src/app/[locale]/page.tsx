import { AccountLink } from "@/components/AccountLink";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { ArrowRight, Zap, Shield, Puzzle } from "lucide-react";

export default function HomePage() {
  const t = useTranslations("landing");

  const features = [
    { icon: Zap, title: t("feature1Title"), desc: t("feature1Desc") },
    { icon: Shield, title: t("feature2Title"), desc: t("feature2Desc") },
    { icon: Puzzle, title: t("feature3Title"), desc: t("feature3Desc") },
  ];

  return (
    <div>
      {/* Hero */}
      <section className="relative py-24 px-6 text-center">
        <div className="max-w-4xl mx-auto">
          <h1 className="text-5xl font-bold tracking-tight mb-6">
            {t("heroTitle")}
          </h1>
          <p className="text-xl text-[var(--color-muted)] mb-10 max-w-2xl mx-auto">
            {t("heroDescription")}
          </p>
          <div className="flex items-center justify-center gap-4">
            <AccountLink
              href="/register"
              className="inline-flex items-center gap-2 bg-primary-600 hover:bg-primary-700 text-white px-8 py-3 rounded-lg font-medium transition-colors"
            >
              {t("getStarted")}
              <ArrowRight className="w-4 h-4" />
            </AccountLink>
            <Link
              href="#features"
              className="inline-flex items-center gap-2 border border-[var(--color-border)] hover:bg-[var(--color-card)] px-8 py-3 rounded-lg font-medium transition-colors"
            >
              {t("learnMore")}
            </Link>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="py-20 px-6">
        <div className="max-w-6xl mx-auto">
          <h2 className="text-3xl font-bold text-center mb-16">
            {t("featuresTitle")}
          </h2>
          <div className="grid md:grid-cols-3 gap-8">
            {features.map((feature) => (
              <div
                key={feature.title}
                className="p-8 rounded-xl bg-[var(--color-card)] border border-[var(--color-border)]"
              >
                <feature.icon className="w-10 h-10 text-primary-500 mb-4" />
                <h3 className="text-xl font-semibold mb-3">{feature.title}</h3>
                <p className="text-[var(--color-muted)]">{feature.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-20 px-6 text-center">
        <div className="max-w-2xl mx-auto">
          <h2 className="text-3xl font-bold mb-4">{t("ctaTitle")}</h2>
          <p className="text-lg text-[var(--color-muted)] mb-8">
            {t("ctaDescription")}
          </p>
          <AccountLink
            href="/register"
            className="inline-flex items-center gap-2 bg-primary-600 hover:bg-primary-700 text-white px-8 py-3 rounded-lg font-medium transition-colors"
          >
            {t("ctaButton")}
            <ArrowRight className="w-4 h-4" />
          </AccountLink>
        </div>
      </section>
    </div>
  );
}
