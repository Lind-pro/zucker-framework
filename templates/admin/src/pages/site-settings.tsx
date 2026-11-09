import {
  Button,
  ErrorState,
  Field,
  Input,
  LoadingState,
  Notice,
  PageContainer,
  Panel,
  Select,
  Tabs,
  Textarea,
  toast,
  useAdminApi,
  usePermissionCheck,
  useResource,
} from '@zucker-framework/fe-admin';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useText } from '../text';

type LinkValue = { label: string; href: string };
type Language = 'zh' | 'en';
interface SiteSettings {
  name: string;
  theme: string;
  appearance: 'light' | 'dark' | 'system';
  description: Record<Language, string>;
  navigation: Record<Language, LinkValue[]>;
  footerLinks: Record<Language, LinkValue[]>;
}

function LinkEditor({ label, links, onChange, disabled }: { label: string; links: LinkValue[]; onChange: (links: LinkValue[]) => void; disabled: boolean }) {
  const tx = useText();
  return (
    <fieldset className="space-y-2 rounded-lg border p-3">
      <legend className="px-1 text-sm font-medium">{label}</legend>
      {links.map((link, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2">
          <Input
            className="w-40"
            aria-label={tx(`${label}名称 ${index + 1}`, `${label} label ${index + 1}`)}
            placeholder={tx('链接名称', 'Label')}
            maxLength={80}
            disabled={disabled}
            value={link.label}
            onChange={(event) => onChange(links.map((item, position) => (position === index ? { ...item, label: event.target.value } : item)))}
          />
          <Input
            className="w-72 max-w-full"
            aria-label={tx(`${label}地址 ${index + 1}`, `${label} URL ${index + 1}`)}
            placeholder="/about · https://…"
            disabled={disabled}
            value={link.href}
            onChange={(event) => onChange(links.map((item, position) => (position === index ? { ...item, href: event.target.value } : item)))}
          />
          <Button
            size="icon"
            variant="ghost"
            aria-label={tx(`删除${label} ${index + 1}`, `Delete ${label} ${index + 1}`)}
            disabled={disabled}
            onClick={() => onChange(links.filter((_, position) => position !== index))}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <Button size="sm" icon={<Plus />} disabled={disabled || links.length >= 12} onClick={() => onChange([...links, { label: '', href: '' }])}>
        {tx('添加链接', 'Add link')}
      </Button>
    </fieldset>
  );
}

/** Public site brand, bilingual links and default appearance (`/content/manage/settings`). */
export function SiteSettingsPage() {
  const api = useAdminApi();
  const tx = useText();
  const can = usePermissionCheck();
  const [draft, setDraft] = useState<SiteSettings | null>(null);
  const [defaults, setDefaults] = useState(false);
  const [saving, setSaving] = useState(false);
  const settings = useResource(async (signal) => {
    const result = await api.get<{ settings: SiteSettings; usingDefaults: boolean }>('/content/manage/settings', undefined, { signal });
    setDraft(result.settings);
    setDefaults(result.usingDefaults);
    return result;
  }, []);
  const canSave = can('content:manage');
  async function save() {
    if (!draft) return;
    const incomplete = (['zh', 'en'] as const).some((language) =>
      [...draft.navigation[language], ...draft.footerLinks[language]].some((link) => !link.label.trim() || !link.href.trim()),
    );
    if (!draft.name.trim() || incomplete) {
      toast.error(tx('请填写网站名称及所有链接的名称和地址', 'Enter the site name and every link label and URL'));
      return;
    }
    setSaving(true);
    try {
      await api.put('/content/manage/settings', draft);
      setDefaults(false);
      toast.success(tx('站点配置已保存', 'Site settings saved'));
    } catch {
      toast.error(tx('保存失败，请检查链接格式、字段长度或权限。', 'Save failed; check link formats, field lengths or access.'));
    } finally {
      setSaving(false);
    }
  }
  const update = (patch: Partial<SiteSettings>) => setDraft((previous) => (previous ? { ...previous, ...patch } : previous));
  return (
    <PageContainer title={tx('站点配置', 'Site settings')} description={tx('维护公开网站的品牌、双语链接与默认外观，保存后刷新网站即可生效。', 'Maintain the public site brand, bilingual links and default appearance; reload the site after saving.')}>
      <Notice tone="info" title={tx('配置生效范围', 'Scope')}>
        {tx(
          '本页只修改公开站点品牌、双语链接与默认外观。账户、邮件、支付和存储连接由各自的部署配置管理。',
          'This page changes only the public site brand, bilingual links and appearance. Account, mail, payment and storage connections are configured separately.',
        )}
      </Notice>
      {settings.error ? (
        <ErrorState onRetry={settings.reload} />
      ) : !draft ? (
        <LoadingState />
      ) : (
        <Panel>
          <form
            className="max-w-4xl space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            {defaults && <Notice tone="info" title={tx('当前使用默认站点设置；保存后将写入数据库。', 'Default site settings are in use; saving stores them.')} />}
            <Field label={tx('网站名称', 'Site name')} required>
              {({ id }) => <Input id={id} maxLength={100} disabled={saving} value={draft.name} onChange={(event) => update({ name: event.target.value })} />}
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={tx('命名主题', 'Theme')} required description={tx('当前提供 default 主题；未知主题由公开站点安全回退。', 'The default theme is available; unknown themes fall back safely.')}>
                {({ id }) => <Input id={id} disabled={saving} value={draft.theme} onChange={(event) => update({ theme: event.target.value })} />}
              </Field>
              <Field label={tx('默认外观', 'Appearance')} required>
                {({ id }) => (
                  <Select
                    id={id}
                    disabled={saving}
                    value={draft.appearance}
                    onChange={(event) => update({ appearance: event.target.value as SiteSettings['appearance'] })}
                    options={[
                      { value: 'light', label: tx('浅色', 'Light') },
                      { value: 'dark', label: tx('深色', 'Dark') },
                      { value: 'system', label: tx('跟随系统', 'System') },
                    ]}
                  />
                )}
              </Field>
            </div>
            <Tabs
              label={tx('语言', 'Language')}
              items={(['zh', 'en'] as const).map((language) => ({
                value: language,
                label: language === 'zh' ? '中文' : 'English',
                content: (
                  <div className="space-y-4">
                    <Field label={tx('站点简介', 'Description')}>
                      {({ id }) => (
                        <Textarea
                          id={id}
                          rows={3}
                          maxLength={500}
                          disabled={saving}
                          value={draft.description[language]}
                          onChange={(event) => update({ description: { ...draft.description, [language]: event.target.value } })}
                        />
                      )}
                    </Field>
                    <LinkEditor label={tx('导航链接', 'Navigation')} links={draft.navigation[language]} disabled={saving} onChange={(links) => update({ navigation: { ...draft.navigation, [language]: links } })} />
                    <LinkEditor label={tx('页脚链接', 'Footer links')} links={draft.footerLinks[language]} disabled={saving} onChange={(links) => update({ footerLinks: { ...draft.footerLinks, [language]: links } })} />
                  </div>
                ),
              }))}
            />
            {canSave && (
              <Button type="submit" variant="primary" loading={saving}>
                {tx('保存站点配置', 'Save site settings')}
              </Button>
            )}
          </form>
        </Panel>
      )}
    </PageContainer>
  );
}
