import { useCallback, useEffect, type ReactNode } from 'react';
import { create } from 'zustand';
import { Select } from 'antd';
import { translateAdminText, type AdminLocale, type AdminMessageParams } from './messages';

export { translateAdminText } from './messages';
export type { AdminLocale, AdminMessageParams } from './messages';
export const ADMIN_LOCALE_STORAGE_KEY = 'zucker-admin-locale';
function initialLocale(): AdminLocale {
  try {
    return localStorage.getItem(ADMIN_LOCALE_STORAGE_KEY) === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}
const useLocaleStore = create<{ locale: AdminLocale; setLocale: (locale: AdminLocale) => void }>(
  (set) => ({
    locale: initialLocale(),
    setLocale: (locale) => {
      if (locale !== 'zh' && locale !== 'en') return;
      set({ locale });
      try {
        localStorage.setItem(ADMIN_LOCALE_STORAGE_KEY, locale);
      } catch {
        /* In-memory switching still works when storage is unavailable. */
      }
    },
  }),
);
export function useAdminI18n() {
  const locale = useLocaleStore((state) => state.locale),
    setLocale = useLocaleStore((state) => state.setLocale);
  const t = useCallback(
    (chinese: string, english?: string, params?: AdminMessageParams) =>
      translateAdminText(locale, chinese, english, params),
    [locale],
  );
  return { locale, localeTag: locale === 'zh' ? 'zh-CN' : 'en-US', setLocale, t };
}
/** Updates metadata and locale consumers without remounting routes or discarding form drafts. */
export function AdminLocaleProvider({ children }: { children: ReactNode }) {
  const { locale, localeTag, t } = useAdminI18n();
  useEffect(() => {
    document.documentElement.lang = localeTag;
    document.title = t('管理后台');
  }, [locale, localeTag, t]);
  return children;
}
export function LanguageSwitcher() {
  const { locale, setLocale } = useAdminI18n();
  return (
    <Select
      aria-label="Language / 语言"
      value={locale}
      onChange={setLocale}
      style={{ minWidth: 108 }}
      options={[
        { value: 'zh', label: '中文' },
        { value: 'en', label: 'English' },
      ]}
    />
  );
}
