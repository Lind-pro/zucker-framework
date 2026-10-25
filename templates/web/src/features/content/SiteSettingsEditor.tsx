'use client';
import { useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { httpClient } from '@/lib/http-client';
import type { SiteSettings } from './types';
import {
  errorMessage,
  Field,
  ManageShell,
  Notice,
  panel,
  primary,
  secondary,
  useCopy,
} from './management';

export function SiteSettingsEditor() {
  const t = useCopy(),
    locale = useLocale();
  const [settings, setSettings] = useState<SiteSettings | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void httpClient
      .get<{ settings: SiteSettings }>('/content/manage/settings')
      .then((data) => {
        if (active) setSettings(data.settings);
      })
      .catch((e) => {
        if (active) setError(errorMessage(e, locale === 'zh'));
      });
    return () => {
      active = false;
    };
  }, [locale]);
  return (
    <ManageShell title={t('站点设置', 'Site settings')}>
      <Notice error={error} />
      {settings ? (
        <SettingsForm initial={settings} />
      ) : error ? (
        <button className={secondary} onClick={() => window.location.reload()}>
          {t('重新加载', 'Reload')}
        </button>
      ) : (
        <p>{t('正在加载…', 'Loading…')}</p>
      )}
    </ManageShell>
  );
}
function SettingsForm({ initial }: { initial: SiteSettings }) {
  const t = useCopy(),
    locale = useLocale();
  const [settings, setSettings] = useState(initial),
    [navigation, setNavigation] = useState(JSON.stringify(initial.navigation, null, 2)),
    [footer, setFooter] = useState(JSON.stringify(initial.footerLinks, null, 2));
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  async function save() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      let parsed;
      try {
        parsed = {
          ...settings,
          navigation: JSON.parse(navigation),
          footerLinks: JSON.parse(footer),
        };
      } catch {
        setError(t('导航与页脚需要有效 JSON。', 'Navigation and footer links must be valid JSON.'));
        return;
      }
      const result = await httpClient.put<{ settings: SiteSettings }>(
        '/content/manage/settings',
        parsed,
      );
      setSettings(result.settings);
      setNavigation(JSON.stringify(result.settings.navigation, null, 2));
      setFooter(JSON.stringify(result.settings.footerLinks, null, 2));
      setMessage(
        t(
          '设置已保存，刷新公开页面可查看效果。',
          'Settings saved. Refresh a public page to see the changes.',
        ),
      );
    } catch (e) {
      setError(errorMessage(e, locale === 'zh'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="max-w-4xl space-y-6">
      <Notice error={error} message={message} />
      <fieldset disabled={busy} className={`${panel} grid gap-6 sm:grid-cols-2`}>
        <Field label={t('网站名称', 'Site name')}>
          <input
            className="content-input"
            value={settings.name}
            onChange={(e) => setSettings({ ...settings, name: e.target.value })}
          />
        </Field>
        <Field label={t('默认外观', 'Default appearance')}>
          <select
            className="content-input"
            value={settings.appearance}
            onChange={(e) =>
              setSettings({ ...settings, appearance: e.target.value as SiteSettings['appearance'] })
            }
          >
            <option value="light">{t('浅色', 'Light')}</option>
            <option value="dark">{t('深色', 'Dark')}</option>
            <option value="system">{t('跟随系统', 'System')}</option>
          </select>
        </Field>
        <Field label={t('主题名称', 'Theme name')}>
          <input
            className="content-input"
            value={settings.theme}
            onChange={(e) => setSettings({ ...settings, theme: e.target.value })}
          />
        </Field>
        <p className="self-center text-sm text-[var(--color-muted)]">
          {t(
            '当前可用主题：default。未知主题安全回退到 default。',
            'Available theme: default. Unknown themes fall back to default.',
          )}
        </p>
        {(['zh', 'en'] as const).map((language) => (
          <Field
            key={language}
            label={language === 'zh' ? '中文站点简介' : 'English site description'}
          >
            <textarea
              className="content-input"
              rows={3}
              value={settings.description[language]}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  description: { ...settings.description, [language]: e.target.value },
                })
              }
            />
          </Field>
        ))}
        <div className="sm:col-span-2">
          <Field label={t('导航链接（按 zh / en 分组）', 'Navigation links (grouped by zh / en)')}>
            <textarea
              rows={12}
              className="content-input font-mono text-sm"
              value={navigation}
              onChange={(e) => setNavigation(e.target.value)}
            />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label={t('页脚链接（按 zh / en 分组）', 'Footer links (grouped by zh / en)')}>
            <textarea
              rows={8}
              className="content-input font-mono text-sm"
              value={footer}
              onChange={(e) => setFooter(e.target.value)}
            />
          </Field>
          <p className="mt-3 text-xs text-[var(--color-muted)]">
            {t(
              '每个链接使用 { "label": "链接名称", "href": "/about" }。相对路径会自动加上语言前缀。',
              'Use { "label": "About", "href": "/about" } for each link. Local paths receive a language prefix.',
            )}
          </p>
        </div>
      </fieldset>
      <button className={primary} disabled={busy} onClick={() => void save()}>
        {t('保存站点设置', 'Save site settings')}
      </button>
    </div>
  );
}
