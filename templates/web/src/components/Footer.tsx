import { useTranslations } from "next-intl";

export function Footer() {
  const t = useTranslations("footer");

  return (
    <footer className="border-t border-[var(--color-border)] py-12 px-6">
      <div className="max-w-6xl mx-auto grid md:grid-cols-4 gap-8">
        <div>
          <p className="font-bold text-lg mb-3">Zucker</p>
          <p className="text-sm text-[var(--color-muted)]">
            &copy; {new Date().getFullYear()} Zucker. {t("copyright")}
          </p>
        </div>
        <div>
          <p className="font-medium mb-3">{t("product")}</p>
          <ul className="space-y-2 text-sm text-[var(--color-muted)]">
            <li><a href="#features" className="hover:text-[var(--color-foreground)]">Features</a></li>
            <li><a href="#" className="hover:text-[var(--color-foreground)]">Pricing</a></li>
          </ul>
        </div>
        <div>
          <p className="font-medium mb-3">{t("support")}</p>
          <ul className="space-y-2 text-sm text-[var(--color-muted)]">
            <li><a href="#" className="hover:text-[var(--color-foreground)]">{t("contact")}</a></li>
          </ul>
        </div>
        <div>
          <p className="font-medium mb-3">{t("legal")}</p>
          <ul className="space-y-2 text-sm text-[var(--color-muted)]">
            <li><a href="#" className="hover:text-[var(--color-foreground)]">{t("terms")}</a></li>
            <li><a href="#" className="hover:text-[var(--color-foreground)]">{t("privacy")}</a></li>
          </ul>
        </div>
      </div>
    </footer>
  );
}
