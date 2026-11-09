import { createContext, useContext, type ReactNode } from 'react';
import { formatMessage, type MessageParams } from './format';
import { zhCN, type AdminMessageKey, type AdminMessages } from './zh-CN';

export type Translate = (key: AdminMessageKey, params?: MessageParams) => string;

export interface AdminI18nValue {
  /** BCP 47 tag of the active locale, used for dates and numbers. */
  locale: string;
  messages: AdminMessages;
  t: Translate;
  /** Locales available for switching; a single entry hides the switcher. */
  locales: ReadonlyArray<{ value: string; label: string }>;
  setLocale: (locale: string) => void;
  /**
   * Translate server-provided display text (`serverLabels` config). The stable `labelKey` the server
   * sends next to the text is looked up first, then the text itself; unknown text is returned as is.
   */
  serverLabel: (text: string, labelKey?: string | null) => string;
}

/** Resolve `serverLabels` for one locale: `labels[labelKey] ?? labels[text] ?? text`. */
export function createServerLabel(
  labels: Readonly<Record<string, Readonly<Record<string, string>>>> | ((text: string, locale: string) => string | undefined) | undefined,
  locale: string,
): (text: string, labelKey?: string | null) => string {
  if (!labels) return (text) => text;
  const lookup: (value: string) => string | undefined =
    typeof labels === 'function'
      ? (value) => labels(value, locale)
      : (() => {
          const table = Object.prototype.hasOwnProperty.call(labels, locale) ? labels[locale] : undefined;
          return (value: string) => (table && Object.prototype.hasOwnProperty.call(table, value) ? table[value] : undefined);
        })();
  const found = (value: unknown) => {
    if (typeof value !== 'string' || !value) return undefined;
    const translated = lookup(value);
    return typeof translated === 'string' && translated ? translated : undefined;
  };
  return (text, labelKey) => found(labelKey) ?? found(text) ?? text;
}

export function createTranslate(messages: AdminMessages): Translate {
  return (key, params) => formatMessage(messages[key] ?? zhCN[key] ?? key, params);
}

const fallback: AdminI18nValue = {
  locale: 'zh-CN',
  messages: zhCN,
  t: createTranslate(zhCN),
  locales: [{ value: 'zh-CN', label: '中文' }],
  setLocale: () => undefined,
  serverLabel: (text) => text,
};

const I18nContext = createContext<AdminI18nValue>(fallback);

export function AdminI18nProvider({ value, children }: { value: AdminI18nValue; children: ReactNode }) {
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Interface copy for components; works without a provider using the zh-CN defaults. */
export function useAdminI18n(): AdminI18nValue {
  return useContext(I18nContext);
}
