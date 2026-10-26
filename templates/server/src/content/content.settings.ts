import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@zucker-framework/config';
import { safeSiteHref, type SiteColorMode } from '@zucker-framework/fe-site/content';
import { CONTENT_OPTIONS, type ContentOptions } from './content.options';
import * as input from './content.validation';
import type { ContentLocale } from './content.types';

export interface SiteLink { label: string; href: string }
export interface SiteSettings {
  name: string;
  theme: string;
  appearance: SiteColorMode;
  description: Record<ContentLocale, string>;
  navigation: Record<ContentLocale, SiteLink[]>;
  footerLinks: Record<ContentLocale, SiteLink[]>;
}
export function defaultSiteSettings(): SiteSettings {
  return { name: 'Zucker', theme: 'default', appearance: 'dark', description: { zh: '网站内容与文档', en: 'Site content and documentation' },
    navigation: { zh: [{ label: '首页', href: '/' }, { label: '套餐', href: '/pricing' }, { label: '博客', href: '/blog' }, { label: '文档', href: '/docs' }],
      en: [{ label: 'Home', href: '/' }, { label: 'Pricing', href: '/pricing' }, { label: 'Blog', href: '/blog' }, { label: 'Docs', href: '/docs' }] },
    footerLinks: { zh: [], en: [] } };
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
  const raw = input.record(value, ['name', 'theme', 'appearance', 'description', 'navigation', 'footerLinks']);
  const theme = input.boundedText(raw.theme, 64, true);
  if (!/^[a-z][a-z0-9-]*$/.test(theme)) throw new BadRequestException('Invalid theme identifier');
  if (!['light', 'dark', 'system'].includes(String(raw.appearance))) throw new BadRequestException('Invalid default appearance');
  const descriptions = input.record(raw.description, ['zh', 'en']);
  const navigation = input.record(raw.navigation, ['zh', 'en']), footerLinks = input.record(raw.footerLinks, ['zh', 'en']);
  return { name: input.boundedText(raw.name, 100, true), theme, appearance: raw.appearance as SiteColorMode,
    description: { zh: input.boundedText(descriptions.zh, 500), en: input.boundedText(descriptions.en, 500) },
    navigation: { zh: links(navigation.zh), en: links(navigation.en) }, footerLinks: { zh: links(footerLinks.zh), en: links(footerLinks.en) } };
}

@Injectable()
export class ContentSettingsService {
  constructor(private readonly config: ConfigService, @Inject(CONTENT_OPTIONS) private readonly options: ContentOptions) {}
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
    return { settings, usingDefaults: false };
  }
  async publicSettings(language: unknown) {
    const locale = input.locale(language), { settings } = await this.read();
    return { name: settings.name, description: settings.description[locale], theme: settings.theme, appearance: settings.appearance,
      navigation: settings.navigation[locale], footerLinks: settings.footerLinks[locale], siteUrl: this.options.siteUrl };
  }
}
