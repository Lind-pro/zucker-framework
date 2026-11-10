import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import {
  parseTemplate,
  parseTemplateWithMapper,
  safeHtmlLinkHref,
  type DatabaseAdapter,
  type ModelOperations,
} from '@zucker-framework/core';

/** Placeholder at the start of a URL-valued attribute (href/src/action/formaction/xlink:href). */
const URL_ATTRIBUTE_VARIABLE = /(\b(?:href|src|action|formaction|xlink:href)\s*=\s*["']?\s*)\{\{(\w+)\}\}/gi;
const URL_MARKER = '__zucker_url_attr__';

export type ResolvedTemplate = Record<string, string | null>;
export interface BuiltInMailTemplate {
  key: string;
  name: string;
  description: string;
  defaultSubject?: string;
  contents: ResolvedTemplate;
  metadata?: Record<string, unknown>;
}
export interface BuiltInTemplateInfo {
  key: string;
  name: string;
  description: string;
  variables: string[];
  defaultSubject?: string;
  [key: string]: unknown;
}
export interface MailTemplateCatalogOptions {
  database: DatabaseAdapter;
  model?: string;
  defaultLocale: string;
  contentFields: Record<string, string>;
  builtIns: BuiltInMailTemplate[];
  fallback?: () => ResolvedTemplate;
}
interface TemplateRecord extends Record<string, unknown> {
  id: string;
  key: string;
  name: string;
  isActive: boolean;
}
const LIMITS = { key: 64, name: 100, description: 500, subject: 200, html: 200000 };
function validateText(field: string, value: unknown, limit: number, required = false): void {
  if (value == null) {
    if (required) throw new BadRequestException(`${field} 不能为空`);
    return;
  }
  if (typeof value !== 'string') throw new BadRequestException(`${field} 必须为字符串`);
  if (required && !value.trim()) throw new BadRequestException(`${field} 不能为空`);
  if (value.length > limit) throw new BadRequestException(`${field} 长度不能超过 ${limit} 字符`);
}

/** Uses the existing template parser with the mail placeholder grammar. */
export function extractMailVariables(...contents: Array<string | null | undefined>): string[] {
  const names = new Set<string>();
  for (const text of contents)
    if (text)
      parseTemplateWithMapper(
        text,
        (key) => {
          if (/^\w+$/.test(key)) names.add(key);
          return '';
        },
        { startSymbol: '{{', endSymbol: '}}' },
      );
  return [...names];
}

/** Database overrides and immutable host-supplied templates share one rendering contract. */
export class MailTemplateCatalog {
  private readonly logger = new Logger(MailTemplateCatalog.name);
  private readonly builtIns: Map<string, BuiltInMailTemplate>;
  private readonly info = new Map<string, BuiltInTemplateInfo>();
  constructor(readonly options: MailTemplateCatalogOptions) {
    if (!options.contentFields[options.defaultLocale])
      throw new Error('The default template locale needs a content field');
    this.builtIns = new Map(options.builtIns.map((item) => [item.key, item]));
    for (const item of this.builtIns.values())
      this.info.set(item.key, {
        ...item.metadata,
        key: item.key,
        name: item.name,
        description: item.description,
        defaultSubject: item.defaultSubject,
        variables: extractMailVariables(item.contents[options.defaultLocale]),
      });
  }
  async assertAvailable(key: string): Promise<void> {
    if (this.hasBuiltIn(key)) return;
    const record = (await this.options.database
      .model(this.options.model ?? 'emailTemplates')
      .findUnique({ where: { key }, select: { isActive: true } })) as { isActive: boolean } | null;
    if (!record?.isActive) throw new BadRequestException(`未知或已禁用的模板: ${key}`);
  }

  private get model() {
    return this.options.database.model(
      this.options.model ?? 'emailTemplates',
    ) as ModelOperations<TemplateRecord>;
  }
  private variants(row: Record<string, unknown>): ResolvedTemplate {
    return Object.fromEntries(
      Object.entries(this.options.contentFields).map(([locale, field]) => [
        locale,
        typeof row[field] === 'string' ? row[field] : null,
      ]),
    );
  }
  private builtinContents(key: string): ResolvedTemplate {
    const definition = this.builtIns.get(key);
    const contents = definition?.contents ?? this.options.fallback?.();
    if (!contents) throw new NotFoundException(`Template ${key} not found`);
    return Object.fromEntries(
      Object.keys(this.options.contentFields).map((locale) => [locale, contents[locale] ?? null]),
    );
  }
  async resolve(key: string): Promise<ResolvedTemplate> {
    try {
      const row = await this.model.findUnique({
        where: { key },
        select: Object.fromEntries(
          ['isActive', ...Object.values(this.options.contentFields)].map((field) => [field, true]),
        ),
      });
      if (row?.isActive) return this.variants(row);
    } catch {
      this.logger.warn('Template lookup failed; using the configured built-in fallback');
    }
    return this.builtinContents(key);
  }
  select(contents: ResolvedTemplate, locale?: string): string {
    const language = locale?.split(/[-_]/)[0] || this.options.defaultLocale;
    return (
      (contents[language]?.trim() ? contents[language] : contents[this.options.defaultLocale]) ?? ''
    );
  }
  interpolate(html: string, data: Record<string, unknown>): string {
    const missing = new Set<string>();
    // A variable that starts a URL attribute decides the scheme, so it is restricted to HTTP(S)/mailto
    // (safeHtmlLinkHref). Variables in text or later in a URL only need HTML escaping.
    const marked = html.replace(URL_ATTRIBUTE_VARIABLE, `$1{{${URL_MARKER}$2}}`);
    const result = parseTemplateWithMapper(
      marked,
      (placeholder) => {
        const urlContext = placeholder.startsWith(URL_MARKER);
        const key = urlContext ? placeholder.slice(URL_MARKER.length) : placeholder;
        if (!/^\w+$/.test(key)) return `{{${key}}}`;
        if (!Object.hasOwn(data, key)) {
          missing.add(key);
          return `{{${key}}}`;
        }
        const raw = data[key];
        if (raw == null) return '';
        const text = String(raw);
        if (urlContext) return safeHtmlLinkHref(text);
        return parseTemplate('${value}', { value: text }, { escapeHtml: true });
      },
      { startSymbol: '{{', endSymbol: '}}' },
    );
    if (missing.size) this.logger.warn(`Unresolved template variables: ${[...missing].join(', ')}`);
    return result;
  }
  listBuiltIns(): BuiltInTemplateInfo[] {
    return [...this.info.values()];
  }
  getBuiltInMeta(key: string): BuiltInTemplateInfo | null {
    return this.info.get(key) ?? null;
  }
  hasBuiltIn(key: string): boolean {
    return this.builtIns.has(key);
  }
  getBuiltInHtml(key: string): string {
    return this.builtinContents(key)[this.options.defaultLocale] ?? '';
  }
  getBuiltInVariant(key: string, locale: string): string | null {
    return this.builtIns.get(key)?.contents[locale] ?? null;
  }

  async list() {
    const records = await this.model.findMany({ orderBy: { createdAt: 'desc' } });
    const keys = new Set(records.map((row) => row.key));
    return [
      ...records.map((row) => ({ ...row, isBuiltIn: false })),
      ...this.listBuiltIns()
        .filter((item) => !keys.has(item.key))
        .map((item) => ({
          id: null,
          key: item.key,
          name: item.name,
          description: item.description,
          subject: item.defaultSubject ?? null,
          ...Object.fromEntries(
            Object.values(this.options.contentFields).map((field) => [field, null]),
          ),
          variables: item.variables,
          isActive: true,
          isBuiltIn: true,
          createdAt: null,
          updatedAt: null,
        })),
    ];
  }
  async findOne(id: string) {
    const row = await this.model.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('模板不存在');
    return row;
  }
  private validateContents(data: Record<string, unknown>, creating: boolean) {
    for (const [locale, field] of Object.entries(this.options.contentFields)) {
      validateText(
        field,
        data[field],
        LIMITS.html,
        locale === this.options.defaultLocale && (creating || data[field] !== undefined),
      );
    }
  }
  async create(data: Record<string, unknown>) {
    validateText('key', data.key, LIMITS.key, true);
    validateText('name', data.name, LIMITS.name, true);
    validateText('description', data.description, LIMITS.description);
    validateText('subject', data.subject, LIMITS.subject);
    this.validateContents(data, true);
    const key = (data.key as string).trim();
    if (!/^[\w-]+$/.test(key))
      throw new BadRequestException('模板 key 只能包含字母、数字、下划线、连字符');
    if (await this.model.findUnique({ where: { key } }))
      throw new BadRequestException(`模板 key "${key}" 已存在`);
    return this.model.create({
      data: {
        key,
        name: data.name,
        description: data.description,
        subject: data.subject,
        ...Object.fromEntries(
          Object.values(this.options.contentFields).map((field) => [field, data[field]]),
        ),
        variables: extractMailVariables(...Object.values(this.variants(data))),
      },
    });
  }
  async seed(key: string) {
    if (await this.model.findUnique({ where: { key } }))
      throw new BadRequestException(`DB 模板 "${key}" 已存在，请直接编辑`);
    const meta = this.getBuiltInMeta(key);
    if (!meta) throw new NotFoundException(`内置模板 "${key}" 不存在`);
    const contents = this.builtinContents(key);
    return this.model.create({
      data: {
        key,
        name: meta.name,
        description: meta.description,
        subject: meta.defaultSubject,
        ...Object.fromEntries(
          Object.entries(this.options.contentFields).map(([locale, field]) => [
            field,
            contents[locale],
          ]),
        ),
        variables: extractMailVariables(...Object.values(contents)),
        isActive: true,
      },
    });
  }
  async update(id: string, data: Record<string, unknown>) {
    for (const field of ['name', 'description', 'subject'] as const)
      validateText(field, data[field], LIMITS[field]);
    this.validateContents(data, false);
    if (data.isActive !== undefined && typeof data.isActive !== 'boolean')
      throw new BadRequestException('isActive 必须为布尔值');
    const existing = await this.findOne(id);
    const fields = [
      'name',
      'description',
      'subject',
      'isActive',
      ...Object.values(this.options.contentFields),
    ];
    const updates: Record<string, unknown> = Object.fromEntries(
      fields.filter((field) => data[field] !== undefined).map((field) => [field, data[field]]),
    );
    if (Object.values(this.options.contentFields).some((field) => data[field] !== undefined)) {
      updates.variables = extractMailVariables(
        ...Object.values(this.variants({ ...existing, ...updates })),
      );
    }
    return this.model.update({ where: { id }, data: updates });
  }
  async remove(id: string) {
    await this.findOne(id);
    await this.model.delete({ where: { id } });
    return { ok: true };
  }
  draftContents(data: Record<string, unknown>, locale?: string): string {
    this.validateContents(data, true);
    return this.select(this.variants(data), locale);
  }
}
