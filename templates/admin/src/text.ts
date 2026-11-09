import { useAdminI18n } from '@zucker-framework/fe-admin';

/** Template-local bilingual copy for the pages this application adds to the back office. */
export function useText() {
  const { locale } = useAdminI18n();
  return (zh: string, en: string) => (locale.startsWith('en') ? en : zh);
}
