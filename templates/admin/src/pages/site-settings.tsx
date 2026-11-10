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
  Switch,
  Tabs,
  Textarea,
  toast,
  useAdminApi,
  usePermissionCheck,
  useResource,
} from '@zucker-framework/fe-admin';
import { safeSiteHref } from '@zucker-framework/fe-site/content';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { PublicAssetUploadButton } from '../features/public-assets/upload-button';
import { useText } from '../text';

type LinkValue = { label: string; href: string };
type Language = 'zh' | 'en';
/** `platform` is a lowercase identifier the site theme maps to an icon (`github`, `x`, …). */
type SocialLink = { platform: string; href: string };
interface SiteSettings {
  name: string;
  theme: string;
  appearance: 'light' | 'dark' | 'system';
  description: Record<Language, string>;
  navigation: Record<Language, LinkValue[]>;
  footerLinks: Record<Language, LinkValue[]>;
  /** Safe site href, or '' for the text brand. */
  logoUrl: string;
  social: SocialLink[];
  /** Announcement bar; `href` '' shows plain text; the text of the visitor's language is used. */
  banner: { enabled: boolean; text: Record<Language, string>; href: string };
}
/** Mirrors the server's `content.settings.ts` limits; the server re-validates every field. */
const SOCIAL_PLATFORM = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_SOCIAL_LINKS = 12;
const BANNER_TEXT_MAX = 200;
const emptyBanner = (): SiteSettings['banner'] => ({ enabled: false, text: { zh: '', en: '' }, href: '' });

/** Settings saved before these fields existed come back without them. */
function withDefaults(settings: SiteSettings): SiteSettings {
  return {
    ...settings,
    logoUrl: settings.logoUrl ?? '',
    social: Array.isArray(settings.social) ? settings.social : [],
    banner: settings.banner ? { ...emptyBanner(), ...settings.banner, text: { ...emptyBanner().text, ...settings.banner.text } } : emptyBanner(),
  };
}

/** Client-side check before PUT; returns a message or null. */
export function siteSettingsProblem(draft: SiteSettings, tx: (zh: string, en: string) => string): string | null {
  const incomplete = (['zh', 'en'] as const).some((language) =>
    [...draft.navigation[language], ...draft.footerLinks[language]].some((link) => !link.label.trim() || !link.href.trim()),
  );
  if (!draft.name.trim() || incomplete) return tx('请填写网站名称及所有链接的名称和地址', 'Enter the site name and every link label and URL');
  // A whitespace-only logo URL means "no logo" (it is saved as empty), not an invalid URL.
  if (draft.logoUrl.trim() && !safeSiteHref(draft.logoUrl.trim())) return tx('Logo 地址须为 http(s) 地址或站内路径', 'The logo URL must be an http(s) URL or a site path');
  if (draft.social.some((link) => !SOCIAL_PLATFORM.test(link.platform) || !safeSiteHref(link.href)))
    return tx('社交链接需要小写平台标识（如 github）和有效地址', 'Social links need a lowercase platform id (such as github) and a valid URL');
  if (draft.banner.href && !safeSiteHref(draft.banner.href)) return tx('公告链接须为 http(s) 地址或站内路径', 'The banner link must be an http(s) URL or a site path');
  if (draft.banner.enabled && !draft.banner.text.zh.trim() && !draft.banner.text.en.trim())
    return tx('启用公告时至少填写一种语言的公告文字', 'An enabled banner needs text in at least one language');
  return null;
}

function SocialEditor({ links, onChange, disabled }: { links: SocialLink[]; onChange: (links: SocialLink[]) => void; disabled: boolean }) {
  const tx = useText();
  return (
    <fieldset className="space-y-2 rounded-lg border p-3">
      <legend className="px-1 text-sm font-medium">{tx('社交链接', 'Social links')}</legend>
      <p className="text-xs text-muted-foreground">{tx('平台标识为小写字母（如 github、x、youtube），站点主题据此显示图标。', 'Platform ids are lowercase (github, x, youtube …); the site theme picks the icon.')}</p>
      {links.map((link, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2">
          <Input
            className="w-40"
            aria-label={tx(`平台 ${index + 1}`, `Platform ${index + 1}`)}
            placeholder="github"
            maxLength={32}
            disabled={disabled}
            value={link.platform}
            onChange={(event) => onChange(links.map((item, position) => (position === index ? { ...item, platform: event.target.value.toLowerCase() } : item)))}
          />
          <Input
            className="w-72 max-w-full"
            aria-label={tx(`社交链接地址 ${index + 1}`, `Social link URL ${index + 1}`)}
            placeholder="https://…"
            disabled={disabled}
            value={link.href}
            onChange={(event) => onChange(links.map((item, position) => (position === index ? { ...item, href: event.target.value } : item)))}
          />
          <Button
            size="icon"
            variant="ghost"
            aria-label={tx(`删除社交链接 ${index + 1}`, `Delete social link ${index + 1}`)}
            disabled={disabled}
            onClick={() => onChange(links.filter((_, position) => position !== index))}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <Button size="sm" icon={<Plus />} disabled={disabled || links.length >= MAX_SOCIAL_LINKS} onClick={() => onChange([...links, { platform: '', href: '' }])}>
        {tx('添加社交链接', 'Add social link')}
      </Button>
    </fieldset>
  );
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
    setDraft(withDefaults(result.settings));
    setDefaults(result.usingDefaults);
    return result;
  }, []);
  const canSave = can('content:manage');
  async function save() {
    // Enter in a field submits the form even when the Save button is hidden; the server enforces
    // content:manage too, but a read-only viewer must not send the write at all.
    if (!draft || !canSave) return;
    const problem = siteSettingsProblem(draft, tx);
    if (problem) {
      toast.error(problem);
      return;
    }
    setSaving(true);
    try {
      const logoUrl = draft.logoUrl.trim();
      await api.put('/content/manage/settings', { ...draft, logoUrl });
      if (logoUrl !== draft.logoUrl) update({ logoUrl });
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
    <PageContainer title={tx('站点配置', 'Site settings')} description={tx('维护公开网站的品牌、Logo、社交链接、公告栏、双语链接与默认外观。', 'Maintain the public site brand, logo, social links, announcement banner, bilingual links and default appearance.')}>
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
            <Field
              label={tx('Logo 图片地址', 'Logo image URL')}
              description={tx('http(s) 地址或站内路径；留空时显示网站名称。', 'An http(s) URL or a site path; empty shows the site name.')}
            >
              {({ id, describedBy }) => (
                <div className="flex flex-wrap items-center gap-3">
                  <Input id={id} aria-describedby={describedBy} className="max-w-xl" maxLength={2048} placeholder="/logo.svg · https://…" disabled={saving} value={draft.logoUrl} onChange={(event) => update({ logoUrl: event.target.value })} />
                  <PublicAssetUploadButton disabled={saving} label={tx('上传 Logo', 'Upload logo')} onUploaded={(url) => update({ logoUrl: url })} />
                  {safeSiteHref(draft.logoUrl) && <img src={draft.logoUrl} alt="" referrerPolicy="no-referrer" className="h-10 max-w-40 rounded border bg-muted object-contain" />}
                </div>
              )}
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
            <SocialEditor links={draft.social} disabled={saving} onChange={(social) => update({ social })} />
            <fieldset className="space-y-3 rounded-lg border p-3">
              <legend className="px-1 text-sm font-medium">{tx('公告栏', 'Announcement banner')}</legend>
              <Field label={tx('显示公告栏', 'Show the banner')} inline>
                {({ id }) => <Switch id={id} checked={draft.banner.enabled} disabled={saving} onCheckedChange={(enabled) => update({ banner: { ...draft.banner, enabled } })} />}
              </Field>
              <Field label={tx('公告链接', 'Banner link')} description={tx('可选；留空时公告为纯文字。各语言的公告文字在下方语言标签中填写。', 'Optional; empty shows plain text. Enter the text per language in the tabs below.')}>
                {({ id, describedBy }) => (
                  <Input id={id} aria-describedby={describedBy} className="max-w-xl" maxLength={2048} placeholder="/pricing · https://…" disabled={saving} value={draft.banner.href} onChange={(event) => update({ banner: { ...draft.banner, href: event.target.value } })} />
                )}
              </Field>
            </fieldset>
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
                    <Field label={tx('公告文字', 'Banner text')} description={tx('该语言没有文字时不显示公告。', 'No banner is shown for a language without text.')}>
                      {({ id, describedBy }) => (
                        <Input
                          id={id}
                          aria-describedby={describedBy}
                          maxLength={BANNER_TEXT_MAX}
                          disabled={saving}
                          value={draft.banner.text[language]}
                          onChange={(event) => update({ banner: { ...draft.banner, text: { ...draft.banner.text, [language]: event.target.value } } })}
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
