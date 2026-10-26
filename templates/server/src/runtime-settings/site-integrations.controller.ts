import { Controller, Get, Header, ServiceUnavailableException } from '@nestjs/common';
import { Permissions, Public } from '@zucker-framework/auth';
import { ConnectionSettingsService } from './connection-settings.service';
@Controller('site/public')
@Public()
@Permissions()
export class SiteIntegrationsController {
  constructor(private readonly settings: ConnectionSettingsService) {}
  @Get('integrations') @Header('Cache-Control', 'no-store')
  async integrations() {
    try { return await this.settings.publicIntegrations(); }
    catch { throw new ServiceUnavailableException('Applied public website configuration is unavailable'); }
  }
}
