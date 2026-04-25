/**
 * Config controller — admin API for system-scoped configuration.
 *
 * Endpoints:
 * - GET /config   — retrieve all properties for scope 'system'
 * - PUT /config   — bulk-update properties for scope 'system'
 */
import {
  Controller,
  Get,
  Put,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@zucker/config';
import { JwtAuthGuard, PermissionsGuard, Permissions } from '@zucker/auth';

const SYSTEM_SCOPE = 'system';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@Permissions()
@Controller('config')
export class ConfigController {
  constructor(private readonly configService: ConfigService) {}

  /**
   * GET /config
   * Returns all stored (and default) properties for scope 'system'.
   */
  @Get()
  async getAll(): Promise<Record<string, unknown>> {
    return this.configService.getAll(SYSTEM_SCOPE);
  }

  /**
   * PUT /config
   * Bulk-update properties for scope 'system'.
   * Body: Record<string, unknown> — key/value pairs to persist.
   */
  @Put()
  @HttpCode(HttpStatus.OK)
  async setAll(
    @Body() values: Record<string, unknown>,
  ): Promise<{ updated: number }> {
    await this.configService.setProperties(SYSTEM_SCOPE, values);
    return { updated: Object.keys(values).length };
  }
}
