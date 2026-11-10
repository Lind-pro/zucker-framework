import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@zucker-framework/config';
import { safeSiteHref, type SiteColorMode } from '@zucker-framework/fe-site/content';
import { CONTENT_OPTIONS, type ContentOptions } from './content.options';
import * as input from './content.validation';
import type { ContentLocale } from './content.types';
import { ContentRevalidator, contentTags } from './content-revalidate';

export interface SiteLink { label: string; href: string }
/** `platform` is a free lowercase identifier the theme maps to an icon (for example `github`, `x`). */
export interface SiteSocialLink { platform: string; href: string }
export interface SiteBanner { enabled: boolean; text: Record<ContentLocale, string>; href: string }
export interface SiteSettings {
  name: string;
  theme: string;
  appearance: SiteColorMode;
  description: Record<ContentLocale, string>;
  navigation: Record<ContentLocale, SiteLink[]>;
  footerLinks: Record<ContentLocale, SiteLink[]>;
  /** Safe site href or '' for none. */
  logoUrl: string;
  social: SiteSocialLink[];
  /** href '' means the banner is plain text. */
  banner: SiteBanner;
}
/** Starter defaults; operators edit navigation (including the AI links, which need a session) in the admin. */
export function defaultSiteSettings(): SiteSettings {
  return { name: 'Zucker', theme: 'default', appearance: 'dark', description: { zh: '网站内容与文档', en: 'Site content and documentation' },
    navigation: { zh: [{ label: '首页', href: '/' }, { label: 'AI 创作', href: '/ai/image' }, { label: 'AI 对话', href: '/chat' }, { label: '套餐', href: '/pricing' }, { label: '博客', href: '/blog' }, { label: '文档', href: '/docs' }],
      en: [{ label: 'Home', href: '/' }, { label: 'AI studio', href: '/ai/image' }, { label: 'Chat', href: '/chat' }, { label: 'Pricing', href: '/pricing' }, { label: 'Blog', href: '/blog' }, { label: 'Docs', href: '/docs' }] },
    footerLinks: { zh: [{ label: '更新日志', href: '/changelog' }, { label: '隐私政策', href: '/privacy' }, { label: '服务条款', href: '/terms' }, { label: '退款政策', href: '/refund' }],
      en: [{ label: 'Changelog', href: '/changelog' }, { label: 'Privacy', href: '/privacy' }, { label: 'Terms', href: '/terms' }, { label: 'Refunds', href: '/refund' }] },
    logoUrl: '', social: [], banner: { enabled: false, text: { zh: '', en: '' }, href: '' } };
}
function optionalHref(value: unknown, message: string): string {
  if (value === undefined || value === '') return '';
  const href = safeSiteHref(value);
  if (!href) throw new BadRequestException(message);
  return href;
}
function social(value: unknown): SiteSocialLink[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 12) throw new BadRequestException('Site social links support at most 12 entries');
  return value.map(entry => {
    const raw = input.record(entry, ['platform', 'href']);
    if (typeof raw.platform !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(raw.platform)) throw new BadRequestException('Invalid social platform');
    const href = safeSiteHref(raw.href);
    if (!href) throw new BadRequestException('Invalid social link');
    return { platform: raw.platform, href };
  });
}
function banner(value: unknown): SiteBanner {
  if (value === undefined) return { enabled: false, text: { zh: '', en: '' }, href: '' };
  const raw = input.record(value, ['enabled', 'text', 'href']);
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new BadRequestException('Invalid banner state');
  const text = raw.text === undefined ? {} : input.record(raw.text, ['zh', 'en']);
  const result = { enabled: raw.enabled === true, text: { zh: input.boundedText(text.zh, 200), en: input.boundedText(text.en, 200) },
    href: optionalHref(raw.href, 'Invalid banner link') };
  if (result.enabled && !result.text.zh && !result.text.en) throw new BadRequestException('An enabled banner needs text');
  return result;
}
function links(value: unknown): SiteLink[] {
  if (!Array.isArray(value) || value.length > 12) throw new BadRequestException('Site navigation supports at most 12 links');
  return value.map(entry => {
    const raw = input.record(entry, ['label', 'href']), href = safeSiteHref(raw.href);
    if (!href) throw new BadRequestException('Invalid site link');
    return { label: input.boundedText(raw.label, 80, true), href };
  });
}
export function validateSiteSettings(value: unknown): SiteSettings {
  // logoUrl, social and banner are optional so settings saved before they existed still validate.
  const raw = input.record(value, ['name', 'theme', 'appearance', 'description', 'navigation', 'footerLinks', 'logoUrl', 'social', 'banner']);
  const theme = input.boundedText(raw.theme, 64, true);
  if (!/^[a-z][a-z0-9-]*$/.test(theme)) throw new BadRequestException('Invalid theme identifier');
  if (!['light', 'dark', 'system'].includes(String(raw.appearance))) throw new BadRequestException('Invalid default appearance');
  const descriptions = input.record(raw.description, ['zh', 'en']);
  const navigation = input.record(raw.navigation, ['zh', 'en']), footerLinks = input.record(raw.footerLinks, ['zh', 'en']);
  return { name: input.boundedText(raw.name, 100, true), theme, appearance: raw.appearance as SiteColorMode,
    description: { zh: input.boundedText(descriptions.zh, 500), en: input.boundedText(descriptions.en, 500) },
    navigation: { zh: links(navigation.zh), en: links(navigation.en) }, footerLinks: { zh: links(footerLinks.zh), en: links(footerLinks.en) },
    logoUrl: optionalHref(raw.logoUrl, 'Invalid logo link'), social: social(raw.social), banner: banner(raw.banner) };
}

@Injectable()
export class ContentSettingsService {
  constructor(private readonly config: ConfigService, @Inject(CONTENT_OPTIONS) private readonly options: ContentOptions,
    private readonly revalidator: ContentRevalidator) {}
  async read() {
    // getAll reads the durable store, avoiding a stale process-local get() cache across instances.
    const values = await this.config.getAll('site');
    if (values.publicSettings === undefined) return { settings: defaultSiteSettings(), usingDefaults: true };
    try { return { settings: validateSiteSettings(values.publicSettings), usingDefaults: false }; }
    catch { return { settings: defaultSiteSettings(), usingDefaults: true }; }
  }
  async write(value: unknown) {
    const settings = validateSiteSettings(value);
    await this.config.setProperties('site', { publicSettings: settings });
    this.revalidator.schedule([contentTags.all, contentTags.settings]);
    return { settings, usingDefaults: false };
  }
  async publicSettings(language: unknown) {
    const locale = input.locale(language), { settings } = await this.read();
    return { name: settings.name, description: settings.description[locale], theme: settings.theme, appearance: settings.appearance,
      navigation: settings.navigation[locale], footerLinks: settings.footerLinks[locale], siteUrl: this.options.siteUrl,
      logoUrl: settings.logoUrl || null, social: settings.social,
      banner: settings.banner.enabled && settings.banner.text[locale] ? { text: settings.banner.text[locale], href: settings.banner.href || null } : null };
  }
}
