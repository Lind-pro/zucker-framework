import { Inject, Injectable, Logger, type OnApplicationBootstrap, type Type } from '@nestjs/common';
import { createMailLogAdminController, createMailTemplateAdminController, type MailTemplatePreview } from '@zucker-framework/admin';
import { MailService, type MailTemplateCatalog } from '@zucker-framework/notification';
import type { ResolvedMailOptions } from './mail.options';
import { MAIL_OPTIONS } from './mail.tokens';

/** Preview of the stored (or built-in) template text, interpolated with no business sample data. */
@Injectable()
export class BackOfficeMailTemplatePreviewer implements MailTemplatePreview {
  constructor(@Inject(MailService) private readonly mail: MailService) {}
  async previewTemplate(key: string, locale: string) {
    const html = this.mail.templates.select(await this.mail.templates.resolve(key), locale);
    return { html: this.mail.templates.interpolate(html, {}) };
  }
  renderRawHtml(html: string): string { return html; }
}

/** `<templatesPath>` (catalog CRUD, preview, seed) and `<logsPath>` (delivery history) controllers. */
export function createMailAdminControllers(options: ResolvedMailOptions): Type<unknown>[] {
  const guards = options.admin.guards ? [...options.admin.guards] : undefined;
  return [
    createMailTemplateAdminController({ path: options.admin.templatesPath, permissions: { read: options.admin.read, write: options.admin.write },
      auditModule: options.admin.auditModule, previewService: BackOfficeMailTemplatePreviewer, ...(guards ? { guards } : {}) }),
    createMailLogAdminController({ path: options.admin.logsPath, permission: options.admin.read, ...(guards ? { guards } : {}) }),
  ];
}

/**
 * Stores built-in templates as editable rows (missing keys only; an existing row, active or not, is
 * never touched). The code built-ins stay the fallback when a row is deactivated or removed.
 */
export async function seedMailTemplates(catalog: MailTemplateCatalog, keys?: readonly string[]): Promise<{ created: string[]; existing: string[] }> {
  const created: string[] = [], existing: string[] = [];
  for (const key of keys ?? catalog.listBuiltIns().map((item) => item.key)) {
    if (!catalog.hasBuiltIn(key)) throw new Error(`Unknown built-in mail template "${key}"`);
    const model = catalog.options.database.model(catalog.options.model ?? 'emailTemplates');
    if (await model.findUnique({ where: { key } })) { existing.push(key); continue; }
    try {
      await catalog.seed(key);
      created.push(key);
    } catch (error) {
      // A concurrent seeder (another replica) inserted the same key first.
      if (await model.findUnique({ where: { key } })) existing.push(key);
      else throw error;
    }
  }
  return { created, existing };
}

/** Feature `seedTemplates`: seeds at bootstrap; a failure is logged and never blocks startup. */
@Injectable()
export class MailTemplateSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(MailTemplateSeeder.name);
  constructor(@Inject(MailService) private readonly mail: MailService, @Inject(MAIL_OPTIONS) private readonly options: ResolvedMailOptions) {}
  async onApplicationBootstrap(): Promise<void> {
    const seed = this.options.features.seedTemplates;
    if (!seed) return;
    try {
      const result = await seedMailTemplates(this.mail.templates, seed === 'all' ? undefined : seed);
      if (result.created.length) this.logger.log(`Stored ${result.created.length} built-in mail template(s) as editable rows`);
    } catch {
      this.logger.warn('Built-in mail template seeding failed; built-ins remain the fallback');
    }
  }
}
