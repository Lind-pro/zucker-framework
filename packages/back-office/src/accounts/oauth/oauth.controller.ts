import { Body, Controller, Delete, Get, HttpCode, Inject, Optional, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Permissions, Public, RefreshTokenCookie, type RefreshCookieResponse } from '@zucker-framework/auth';
import { AccessLogger } from '@zucker-framework/logging';
import { RateLimit, RateLimitGuard } from '@zucker-framework/rate-limiter';
import { randomBytes } from 'node:crypto';
import { resolveAccountsOptions, type ResolvedAccountsOptions } from '../accounts.options';
import { ACCOUNTS_OPTIONS } from '../accounts.tokens';
import { ACCOUNTS_LIMITER, API_DEFAULT_LIMITER } from '../rate-limits';
import { OAuthService } from './oauth.service';
import type { OAuthRequestContext } from './oauth.types';

interface OAuthRequest { ip?: string; headers: { cookie?: string; origin?: string; 'sec-fetch-site'?: string }; user?: { id: string; sid: string } }
interface OAuthResponse extends RefreshCookieResponse { redirect(url: string): void; setHeader(name: string, value: string): void }

/** `/authorize/oauth/*`: provider list, redirect and One Tap sign-in, account linking and unlinking. */
@Controller('authorize/oauth')
@UseGuards(RateLimitGuard)
@RateLimit(ACCOUNTS_LIMITER)
@Permissions()
@AccessLogger({ describe: 'OAuth authentication', ignore: true })
export class OAuthController {
  private readonly browser: RefreshTokenCookie;
  private readonly session: RefreshTokenCookie;
  private readonly options: ResolvedAccountsOptions;
  constructor(private readonly oauth: OAuthService, @Optional() @Inject(ACCOUNTS_OPTIONS) options?: ResolvedAccountsOptions) {
    this.options = options ?? resolveAccountsOptions({ features: { oauth: true } });
    const browser = this.options.features.oauth?.browserCookie ?? { name: 'zucker-oauth-browser', path: '/api/authorize/oauth' };
    const { name, path, sameSite, domain } = this.options.cookie;
    this.browser = new RefreshTokenCookie({ name: browser.name, path: browser.path, sameSite: 'lax',
      secure: oauth.settings.secureCookies, maxAge: 600_000 });
    this.session = new RefreshTokenCookie({ name, path, sameSite, ...(domain ? { domain } : {}),
      secure: oauth.settings.secureCookies, maxAge: this.options.tokens.refreshTtlSeconds * 1000 });
  }
  private context(req: OAuthRequest): OAuthRequestContext {
    return { browserBinding: this.browser.read(req) ?? '', origin: req.headers.origin, user: req.user, sessionCookie: this.session.read(req) ?? undefined, ip: req.ip };
  }
  private mutation(req: OAuthRequest): OAuthRequestContext {
    const context = this.context(req);
    if (req.headers['sec-fetch-site'] === 'cross-site') context.origin = undefined;
    this.oauth.assertOrigin(context); return context;
  }
  private startContext(req: OAuthRequest, res: OAuthResponse): OAuthRequestContext {
    const context = this.mutation(req);
    if (!/^[A-Za-z0-9_-]{43}$/.test(context.browserBinding)) context.browserBinding = randomBytes(32).toString('base64url');
    this.browser.issue(res, context.browserBinding); this.noStore(res);
    return context;
  }
  private noStore(res: OAuthResponse) { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); }

  @Get('providers') @Public()
  @RateLimit(API_DEFAULT_LIMITER)
  providers(@Res({ passthrough: true }) res: OAuthResponse) { this.noStore(res); return this.oauth.providers(); }

  @Post(':provider/start') @Public() @HttpCode(200)
  start(@Param('provider') provider: string, @Body() body: unknown, @Req() req: OAuthRequest, @Res({ passthrough: true }) res: OAuthResponse) {
    return this.oauth.start(provider, 'login', body, this.startContext(req, res));
  }
  @Post(':provider/link/start') @HttpCode(200)
  linkStart(@Param('provider') provider: string, @Body() body: unknown, @Req() req: OAuthRequest, @Res({ passthrough: true }) res: OAuthResponse) {
    return this.oauth.start(provider, 'link', body, this.startContext(req, res));
  }
  @Get(':provider/callback') @Public()
  async callback(@Param('provider') provider: string, @Query() query: unknown, @Req() req: OAuthRequest, @Res() res: OAuthResponse) {
    this.noStore(res);
    const context = this.context(req), target = await this.oauth.callback(provider, query, context);
    if (new URL(target).hash.startsWith('#ticket=')) this.browser.issue(res, context.browserBinding);
    res.redirect(target);
  }
  @Post('google/onetap') @Public() @HttpCode(200)
  async oneTap(@Body() body: unknown, @Req() req: OAuthRequest, @Res({ passthrough: true }) res: OAuthResponse) {
    this.noStore(res);
    const context = this.mutation(req), result = await this.oauth.oneTap(body, context);
    this.browser.issue(res, context.browserBinding);
    return result;
  }
  @Post(':provider/complete') @Public() @HttpCode(200)
  async complete(@Param('provider') provider: string, @Body() body: unknown, @Req() req: OAuthRequest, @Res({ passthrough: true }) res: OAuthResponse) {
    this.noStore(res);
    const result = await this.oauth.complete(provider, 'login', body, this.mutation(req));
    if (!('twoFactorRequired' in result)) throw new Error('Expected login session');
    // Enrolled accounts finish with POST /authorize/login/two-factor; no cookie is issued here.
    if (result.twoFactorRequired) return { twoFactorRequired: true, challenge: result.challenge, returnPath: result.returnPath };
    this.session.issue(res, result.refreshToken);
    return { token: result.accessToken, userId: result.userId, expires: this.options.tokens.accessTtlSeconds * 1000, returnPath: result.returnPath };
  }
  @Post(':provider/link/complete') @HttpCode(200)
  linkComplete(@Param('provider') provider: string, @Body() body: unknown, @Req() req: OAuthRequest, @Res({ passthrough: true }) res: OAuthResponse) {
    this.noStore(res); return this.oauth.complete(provider, 'link', body, this.mutation(req));
  }
  @Get('connections')
  @RateLimit({ limiter: API_DEFAULT_LIMITER, keyExtractor: '#userId' })
  connections(@Req() req: OAuthRequest) { return this.oauth.connections(req.user!.id); }
  @Delete('connections/:provider')
  async unlink(@Param('provider') provider: string, @Req() req: OAuthRequest, @Res({ passthrough: true }) res: OAuthResponse) {
    const result = await this.oauth.unlink(provider, this.mutation(req));
    if (result.signedOut) this.session.clear(res);
    return result;
  }
}
