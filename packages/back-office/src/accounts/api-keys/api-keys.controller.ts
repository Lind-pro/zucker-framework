import { Body, Controller, Delete, Get, Inject, Optional, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Permissions } from '@zucker-framework/auth';
import { AccessLogger } from '@zucker-framework/logging';
import { RateLimit, RateLimitGuard } from '@zucker-framework/rate-limiter';
import { AccountApiKeyScopes } from '../account.guard';
import { assertAccountOrigin } from '../account-security';
import { accountOrigins, resolveAccountsOptions, type ResolvedAccountsOptions } from '../accounts.options';
import { ACCOUNTS_OPTIONS } from '../accounts.tokens';
import { ACCOUNTS_LIMITER, API_DEFAULT_LIMITER } from '../rate-limits';
import { AccountApiKeysService } from './api-keys.service';

interface ApiKeyRequest { user: { id: string }; headers: { origin?: string; 'sec-fetch-site'?: string } }
interface ApiKeyResponse { setHeader(name: string, value: string): void }

/** `/authorize/api-keys`: list, create (secret returned once), rename and revoke the signed-in account's keys. */
@Controller('authorize/api-keys')
@Permissions()
@UseGuards(RateLimitGuard)
@RateLimit(ACCOUNTS_LIMITER)
@AccessLogger({ describe: 'Account API keys', ignore: true })
export class AccountApiKeysController {
  private readonly origins: ReadonlySet<string>;
  constructor(private readonly keys: AccountApiKeysService, @Optional() @Inject(ACCOUNTS_OPTIONS) options?: ResolvedAccountsOptions) {
    this.origins = accountOrigins(options ?? resolveAccountsOptions());
  }
  private privateResponse(res: ApiKeyResponse) { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Pragma', 'no-cache'); }
  @Get()
  @RateLimit({ limiter: API_DEFAULT_LIMITER, keyExtractor: '#userId' })
  list(@Req() req: ApiKeyRequest, @Res({ passthrough: true }) res: ApiKeyResponse) {
    this.privateResponse(res); return this.keys.list(req.user.id);
  }
  @Post()
  create(@Body() body: unknown, @Req() req: ApiKeyRequest, @Res({ passthrough: true }) res: ApiKeyResponse) {
    assertAccountOrigin(this.origins, req); this.privateResponse(res); return this.keys.create(req.user.id, body);
  }
  @Delete(':id')
  revoke(@Param('id') id: string, @Req() req: ApiKeyRequest, @Res({ passthrough: true }) res: ApiKeyResponse) {
    assertAccountOrigin(this.origins, req); this.privateResponse(res); return this.keys.revoke(req.user.id, id);
  }
  @Patch(':id')
  rename(@Param('id') id: string, @Body() body: unknown, @Req() req: ApiKeyRequest, @Res({ passthrough: true }) res: ApiKeyResponse) {
    assertAccountOrigin(this.origins, req); this.privateResponse(res); return this.keys.rename(req.user.id, id, body);
  }
}

/** `GET /v1/account` with an `account:read` API key: the key owner's public profile. */
@Controller('v1/account')
@Permissions()
@AccessLogger({ describe: 'API key self profile', ignore: true })
export class ApiKeyAccountController {
  constructor(private readonly keys: AccountApiKeysService) {}
  @Get()
  @AccountApiKeyScopes('account:read')
  profile(@Req() req: ApiKeyRequest, @Res({ passthrough: true }) res: ApiKeyResponse) {
    res.setHeader('Cache-Control', 'no-store');
    return this.keys.ownProfile(req.user.id);
  }
}
