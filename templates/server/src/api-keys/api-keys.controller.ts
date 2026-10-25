import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Permissions } from '@zucker-framework/auth';
import { AccessLogger } from '@zucker-framework/logging';
import { RateLimit, RateLimitGuard } from '@zucker-framework/rate-limiter';
import { AccountApiKeyScopes } from '../accounts/api-key-authentication';
import { AccountApiKeysService } from './api-keys.service';

interface AccountRequest { user: { id: string }; headers: { origin?: string; 'sec-fetch-site'?: string } }
interface AccountResponse { setHeader(name: string, value: string): void }

@Controller('authorize/api-keys')
@Permissions()
@UseGuards(RateLimitGuard)
@RateLimit('accounts')
@AccessLogger({ describe: 'Account API keys', ignore: true })
export class AccountApiKeysController {
  private readonly origins = new Set((process.env.ACCOUNT_ORIGINS ?? 'http://localhost:4201,http://localhost:4202').split(',').map(value => value.trim()));
  constructor(private readonly keys: AccountApiKeysService) {}
  private privateResponse(res: AccountResponse) { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Pragma', 'no-cache'); }
  private mutation(req: AccountRequest) {
    if (!req.headers.origin || !this.origins.has(req.headers.origin) || req.headers['sec-fetch-site'] === 'cross-site') throw new ForbiddenException('Untrusted account request origin');
  }
  @Get()
  @RateLimit({ limiter: 'api-default', keyExtractor: '#userId' })
  list(@Req() req: AccountRequest, @Res({ passthrough: true }) res: AccountResponse) {
    this.privateResponse(res); return this.keys.list(req.user.id);
  }
  @Post()
  create(@Body() body: unknown, @Req() req: AccountRequest, @Res({ passthrough: true }) res: AccountResponse) {
    this.mutation(req); this.privateResponse(res); return this.keys.create(req.user.id, body);
  }
  @Delete(':id')
  revoke(@Param('id') id: string, @Req() req: AccountRequest, @Res({ passthrough: true }) res: AccountResponse) {
    this.mutation(req); this.privateResponse(res); return this.keys.revoke(req.user.id, id);
  }
  @Patch(':id')
  rename(@Param('id') id: string, @Body() body: unknown, @Req() req: AccountRequest, @Res({ passthrough: true }) res: AccountResponse) {
    this.mutation(req); this.privateResponse(res); return this.keys.rename(req.user.id, id, body);
  }
}

@Controller('v1/account')
@Permissions()
@AccessLogger({ describe: 'API key self profile', ignore: true })
export class ApiKeyAccountController {
  constructor(private readonly keys: AccountApiKeysService) {}
  @Get()
  @AccountApiKeyScopes('account:read')
  profile(@Req() req: AccountRequest, @Res({ passthrough: true }) res: AccountResponse) {
    res.setHeader('Cache-Control', 'no-store');
    return this.keys.ownProfile(req.user.id);
  }
}
