import { Body, Controller, ForbiddenException, Get, Header, HttpException, Param, Put, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { Permissions } from '@zucker-framework/auth';
import { RateLimit, RateLimitGuard } from '@zucker-framework/rate-limiter';
import { ConnectionSettingsService } from './connection-settings.service';
interface SettingsRequest { user: { id: string }; headers: Record<string, string | string[] | undefined> }
@Controller('management/connection-settings')
@UseGuards(RateLimitGuard)
@RateLimit({ limiter: 'api-default', keyExtractor: '#userId' })
export class ConnectionSettingsController {
  private readonly origins = new Set((process.env.ACCOUNT_ORIGINS ?? 'http://localhost:4201,http://localhost:4202').split(',').map(value => value.trim()));
  constructor(private readonly settings: ConnectionSettingsService) {}
  private async result<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('Connection configuration could not be saved or loaded');
    }
  }
  @Get() @Permissions('config:query') @Header('Cache-Control', 'private, no-store')
  list() { return this.result(() => this.settings.list()); }
  @Get(':profileId') @Permissions('config:query') @Header('Cache-Control', 'private, no-store')
  get(@Param('profileId') id: string) { return this.result(() => this.settings.get(id)); }
  @Put(':profileId') @Permissions('config:update') @Header('Cache-Control', 'private, no-store')
  save(@Req() request: SettingsRequest, @Param('profileId') id: string, @Body() body: unknown) {
    if (typeof request.headers.origin !== 'string' || !this.origins.has(request.headers.origin) || request.headers['sec-fetch-site'] === 'cross-site') throw new ForbiddenException('Untrusted connection update origin');
    return this.result(() => this.settings.save(request.user.id, id, body));
  }
}
