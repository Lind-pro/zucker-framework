import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Inject,
  UseGuards,
  type CanActivate,
  type InjectionToken,
  type Type,
} from '@nestjs/common';
import { JwtAuthGuard, PermissionsGuard, Permissions } from '@zucker-framework/auth';
import { AccessLogger } from '@zucker-framework/logging';
import { MailService } from '@zucker-framework/notification';

export interface MailTemplatePreview {
  previewTemplate(key: string, locale: string): Promise<{ html: string }>;
  renderRawHtml(html: string, locale: string): string;
}
export interface MailTemplateAdminOptions {
  path: string;
  permissions: { read: string; write: string };
  auditModule: string;
  previewService: InjectionToken;
  guards?: Type<CanActivate>[];
}

export function createMailTemplateAdminController(
  options: MailTemplateAdminOptions,
): Type<unknown> {
  @Controller(options.path)
  @UseGuards(...(options.guards ?? [JwtAuthGuard, PermissionsGuard]))
  class MailTemplateController {
    constructor(
      @Inject(MailService) readonly mail: MailService,
      @Inject(options.previewService) readonly previewer: MailTemplatePreview,
    ) {}
    @Get()
    @Permissions(options.permissions.read)
    @AccessLogger({ module: options.auditModule, action: 'list', describe: '获取邮件模板列表' })
    list() {
      return this.mail.templates.list();
    }
    @Get(':id')
    @Permissions(options.permissions.read)
    findOne(@Param('id') id: string) {
      return this.mail.templates.findOne(id);
    }
    @Post()
    @Permissions(options.permissions.write)
    @AccessLogger({ module: options.auditModule, action: 'create', describe: '创建邮件模板' })
    create(@Body() data: Record<string, unknown>) {
      return this.mail.templates.create(data);
    }
    @Post('seed/:key')
    @Permissions(options.permissions.write)
    @AccessLogger({ module: options.auditModule, action: 'seed', describe: '内置模板转为可编辑' })
    seed(@Param('key') key: string) {
      return this.mail.templates.seed(key);
    }
    @Patch(':id')
    @Permissions(options.permissions.write)
    @AccessLogger({ module: options.auditModule, action: 'update', describe: '更新邮件模板' })
    update(@Param('id') id: string, @Body() data: Record<string, unknown>) {
      return this.mail.templates.update(id, data);
    }
    @Delete(':id')
    @Permissions(options.permissions.write)
    @AccessLogger({ module: options.auditModule, action: 'delete', describe: '删除邮件模板' })
    remove(@Param('id') id: string) {
      return this.mail.templates.remove(id);
    }
    @Post(':id/preview')
    @Permissions(options.permissions.read)
    @AccessLogger({ module: options.auditModule, action: 'preview', describe: '预览邮件模板' })
    async preview(@Param('id') id: string, @Body() body: { locale?: string }) {
      const row = await this.mail.templates.findOne(id);
      return this.previewer.previewTemplate(
        row.key,
        body.locale ?? this.mail.templates.options.defaultLocale,
      );
    }
    @Post('preview-html')
    @Permissions(options.permissions.read)
    @AccessLogger({
      module: options.auditModule,
      action: 'previewHtml',
      describe: '预览未保存的 HTML',
    })
    previewHtml(@Body() body: Record<string, unknown>) {
      const locale =
        typeof body.locale === 'string' ? body.locale : this.mail.templates.options.defaultLocale;
      return {
        html: this.previewer.renderRawHtml(this.mail.templates.draftContents(body, locale), locale),
      };
    }
  }
  return MailTemplateController;
}
