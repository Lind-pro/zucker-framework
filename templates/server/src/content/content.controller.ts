import { Body, Controller, ForbiddenException, Get, Header, HttpCode, HttpException, Inject, Param, Post, Put, Query, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { Permissions, Public } from '@zucker-framework/auth';
import { RateLimit, RateLimitGuard } from '@zucker-framework/rate-limiter';
import { ContentService } from './content.service';
import { ContentSettingsService } from './content.settings';
import { CONTENT_OPTIONS, type ContentOptions } from './content.options';

interface ContentRequest { user: { id: string }; headers: Record<string, string | string[] | undefined> }
async function result<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof HttpException) throw error;
    throw new ServiceUnavailableException('Content is temporarily unavailable');
  }
}

@Controller('content/public')
@Public()
@Permissions()
@UseGuards(RateLimitGuard)
@RateLimit('api-default')
export class ContentPublicController {
  constructor(private readonly content: ContentService, private readonly settings: ContentSettingsService) {}
  @Get('entries') @Header('Cache-Control', 'no-store') entries(@Query() query: Record<string, unknown>) { return result(() => this.content.publicEntries(query)); }
  @Get('entry') @Header('Cache-Control', 'no-store') entry(@Query() query: Record<string, unknown>) { return result(() => this.content.publicEntry(query)); }
  @Get('categories') @Header('Cache-Control', 'no-store') categories(@Query('locale') locale?: string) { return result(() => this.content.publicCategories(locale)); }
  @Get('search') @Header('Cache-Control', 'no-store') search(@Query() query: Record<string, unknown>) { return result(() => this.content.publicSearch(query)); }
  @Get('sitemap') @Header('Cache-Control', 'no-store') sitemap(@Query('page') page?: string) { return result(() => this.content.sitemap(page)); }
  @Get('settings') @Header('Cache-Control', 'no-store') configuration(@Query('locale') locale?: string) { return result(() => this.settings.publicSettings(locale)); }
}

@Controller('content/manage')
@Permissions('content:manage')
@UseGuards(RateLimitGuard)
@RateLimit({ limiter: 'api-default', keyExtractor: '#userId' })
export class ContentManagementController {
  private readonly origins: Set<string>;
  constructor(private readonly content: ContentService, private readonly settings: ContentSettingsService,
    @Inject(CONTENT_OPTIONS) options: ContentOptions) { this.origins = new Set(options.origins); }
  private actor(req: ContentRequest): string {
    if (typeof req.headers.origin !== 'string' || !this.origins.has(req.headers.origin) || req.headers['sec-fetch-site'] === 'cross-site')
      throw new ForbiddenException('Untrusted content request origin');
    return req.user.id;
  }
  @Get('entries') @Header('Cache-Control', 'private, no-store') entries(@Query() query: Record<string, unknown>) { return result(() => this.content.adminEntries(query)); }
  @Get('entries/:id') @Header('Cache-Control', 'private, no-store') entry(@Param('id') id: string) { return result(() => this.content.adminEntry(id)); }
  @Post('entries') @HttpCode(200) create(@Req() req: ContentRequest, @Body() body: unknown) {
    const actor = this.actor(req); return result(() => this.content.createEntry(actor, body));
  }
  @Put('entries/:id') update(@Req() req: ContentRequest, @Param('id') id: string, @Body() body: unknown) {
    const actor = this.actor(req); return result(() => this.content.updateEntry(actor, id, body));
  }
  @Post('entries/:id/:action') @HttpCode(200) transition(@Req() req: ContentRequest, @Param('id') id: string, @Param('action') action: string, @Body() body: unknown) {
    const actor = this.actor(req); return result(() => this.content.transitionEntry(actor, id, action, body));
  }
  @Get('categories') @Header('Cache-Control', 'private, no-store') categories(@Query('locale') locale?: string) { return result(() => this.content.adminCategories(locale)); }
  @Get('categories/:id') @Header('Cache-Control', 'private, no-store') category(@Param('id') id: string) { return result(() => this.content.adminCategory(id)); }
  @Post('categories') @HttpCode(200) createCategory(@Req() req: ContentRequest, @Body() body: unknown) {
    const actor = this.actor(req); return result(() => this.content.createCategory(actor, body));
  }
  @Put('categories/:id') updateCategory(@Req() req: ContentRequest, @Param('id') id: string, @Body() body: unknown) {
    const actor = this.actor(req); return result(() => this.content.updateCategory(actor, id, body));
  }
  @Post('categories/:id/:action') @HttpCode(200) transitionCategory(@Req() req: ContentRequest, @Param('id') id: string, @Param('action') action: string, @Body() body: unknown) {
    const actor = this.actor(req); return result(() => this.content.transitionCategory(actor, id, action, body));
  }
  @Get('settings') @Header('Cache-Control', 'private, no-store') configuration() { return result(() => this.settings.read()); }
  @Put('settings') saveConfiguration(@Req() req: ContentRequest, @Body() body: unknown) {
    this.actor(req); return result(() => this.settings.write(body));
  }
}
