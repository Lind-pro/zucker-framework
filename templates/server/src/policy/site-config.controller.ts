import { Controller, Get, Header, ServiceUnavailableException } from '@nestjs/common';
import { Permissions, Public } from '@zucker-framework/auth';
import { PolicyService } from './policy.service';

/**
 * Unauthenticated projection of `public: true` policy fields only: `{policies: {[id]: {revision, values}}}`.
 * No selector parameters. Served from the per-process policy cache, so a burst of server-rendered page
 * loads costs at most one database read per policy per TTL.
 */
@Controller('site/public')
@Public()
@Permissions()
export class SiteConfigController {
  constructor(private readonly policies: PolicyService) {}
  @Get('config') @Header('Cache-Control', 'no-store')
  async config() {
    try { return await this.policies.publicConfig(); }
    catch { throw new ServiceUnavailableException('Public site configuration is unavailable'); }
  }
}
