import { Body, Controller, ForbiddenException, Get, Header, HttpException, Param, Put, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { Permissions } from '@zucker-framework/auth';
import { RateLimit, RateLimitGuard } from '@zucker-framework/rate-limiter';
import { PolicyService } from './policy.service';
interface PolicyRequest { user: { id: string }; headers: Record<string, string | string[] | undefined> }

/** Same permission, Origin and rate-limit contract as `management/connection-settings`. */
@Controller('management/policies')
@UseGuards(RateLimitGuard)
@RateLimit({ limiter: 'api-default', keyExtractor: '#userId' })
export class PolicyController {
  private readonly origins = new Set((process.env.ACCOUNT_ORIGINS ?? 'http://localhost:4201,http://localhost:4202').split(',').map(value => value.trim()));
  constructor(private readonly policies: PolicyService) {}
  private async result<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('Policy configuration could not be saved or loaded');
    }
  }
  @Get() @Permissions('config:query') @Header('Cache-Control', 'private, no-store')
  list() { return this.result(() => this.policies.list()); }
  @Get(':policyId') @Permissions('config:query') @Header('Cache-Control', 'private, no-store')
  get(@Param('policyId') id: string) { return this.result(() => this.policies.view(id)); }
  @Put(':policyId') @Permissions('config:update') @Header('Cache-Control', 'private, no-store')
  save(@Req() request: PolicyRequest, @Param('policyId') id: string, @Body() body: unknown) {
    if (typeof request.headers.origin !== 'string' || !this.origins.has(request.headers.origin) || request.headers['sec-fetch-site'] === 'cross-site') throw new ForbiddenException('Untrusted policy update origin');
    return this.result(() => this.policies.save(request.user.id, id, body));
  }
}
