import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, HttpCode, NotFoundException, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Permissions, Public } from '@zucker-framework/auth';
import { RateLimit, RateLimitGuard } from '@zucker-framework/rate-limiter';
import { AccountApiKeyScopes } from '../accounts/api-key-authentication';
import type { RateLimiterFragment } from '../rate-limits';
import { AICatalogService } from './ai-catalog.service';
import { AITasksService } from './ai-tasks.service';

/** Per-user generation submits (web and API key). */
export const AI_SUBMIT_LIMITER = 'ai-submit';
/** Provider callbacks, per source address; the verifier is the real gate, this bounds abuse. */
export const AI_CALLBACK_LIMITER = 'ai-callback';
export const AI_TASK_RATE_LIMITERS: RateLimiterFragment = Object.freeze({
  [AI_SUBMIT_LIMITER]: { points: 20, duration: 60 },
  [AI_CALLBACK_LIMITER]: { points: 600, duration: 60 },
});
/** Scope an account API key needs for `POST /v1/ai/tasks` and `GET /v1/ai/tasks/:id`. */
export const AI_GENERATE_SCOPE = 'ai:generate';

interface AIRequest {
  user: { id: string; sid: string };
  rawBody?: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

export function trustedOrigins(): Set<string> {
  return new Set((process.env.ACCOUNT_ORIGINS ?? 'http://localhost:4201,http://localhost:4202').split(',').map(value => value.trim()));
}
export function assertTrustedOrigin(origins: ReadonlySet<string>, req: { headers: Record<string, string | string[] | undefined> }): void {
  if (typeof req.headers.origin !== 'string' || !origins.has(req.headers.origin) || req.headers['sec-fetch-site'] === 'cross-site')
    throw new ForbiddenException('Untrusted request origin');
}
const header = (req: AIRequest, name: string) => { const value = req.headers[name]; return typeof value === 'string' ? value : undefined; };

@Controller('ai')
@Permissions()
@UseGuards(RateLimitGuard)
@RateLimit({ limiter: 'api-default', keyExtractor: '#userId' })
export class AITasksController {
  private readonly origins = trustedOrigins();
  constructor(private readonly tasks: AITasksService, private readonly catalog: AICatalogService) {}

  /** Public: models offered per kind with credits and availability, plus chat token pricing. */
  @Get('catalog') @Public() @Header('Cache-Control', 'public, max-age=30')
  @RateLimit('api-default')
  publicCatalog() { return this.catalog.publicView(); }

  @Post('tasks') @HttpCode(202) @Header('Cache-Control', 'private, no-store')
  @RateLimit({ limiter: AI_SUBMIT_LIMITER, keyExtractor: '#userId' })
  submit(@Req() req: AIRequest, @Body() body: unknown) {
    assertTrustedOrigin(this.origins, req);
    return this.tasks.submit(req.user.id, header(req, 'idempotency-key'), body);
  }

  @Get('tasks') @Header('Cache-Control', 'private, no-store')
  list(@Req() req: AIRequest, @Query() query: Record<string, unknown>) { return this.tasks.list(req.user.id, query); }

  @Get('tasks/:id') @Header('Cache-Control', 'private, no-store')
  get(@Req() req: AIRequest, @Param('id') id: string) { return this.tasks.get(req.user.id, id); }

  @Post('tasks/:id/cancel') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  cancel(@Req() req: AIRequest, @Param('id') id: string) {
    assertTrustedOrigin(this.origins, req);
    return this.tasks.cancel(req.user.id, id);
  }

  /** `{ url, expiresAt, expiresInSeconds, contentType, bytes }`; `url` is redeemed at `/api/files/:assetId/download`. */
  @Get('tasks/:id/outputs/:index') @Header('Cache-Control', 'private, no-store')
  output(@Req() req: AIRequest, @Param('id') id: string, @Param('index') index: string) {
    return this.tasks.outputTicket(req.user.id, req.user.sid, id, index);
  }

  /**
   * Provider callback (raw body). Unknown provider 404; unverified 401 (at most one early poll was
   * scheduled from an unauthenticated hint, nothing else changed); verified 200.
   */
  @Post('tasks/callbacks/:provider') @Public() @HttpCode(200) @Header('Cache-Control', 'no-store')
  @RateLimit(AI_CALLBACK_LIMITER)
  async callback(@Req() req: AIRequest, @Param('provider') provider: string) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(provider)) throw new NotFoundException();
    const rawBody = req.rawBody;
    if (!rawBody || rawBody.length > 1024 * 1024) throw new BadRequestException('Raw callback bytes are required');
    const result = await this.tasks.tasks.handleCallback(provider, rawBody, req.headers);
    if (!result.providerKnown) throw new NotFoundException();
    if (!result.verified) throw new BadRequestException({ code: 'AI_CALLBACK_UNVERIFIED', message: 'Callback could not be verified' });
    return { received: true };
  }
}

/** API-key access (account key with scope `ai:generate`); no session, so no download tickets here. */
@Controller('v1/ai')
@Permissions()
@UseGuards(RateLimitGuard)
export class AITasksApiKeyController {
  constructor(private readonly tasks: AITasksService) {}

  @Post('tasks') @HttpCode(202) @Header('Cache-Control', 'no-store')
  @AccountApiKeyScopes(AI_GENERATE_SCOPE)
  @RateLimit({ limiter: AI_SUBMIT_LIMITER, keyExtractor: '#userId' })
  submit(@Req() req: AIRequest, @Body() body: unknown) {
    return this.tasks.submit(req.user.id, header(req, 'idempotency-key'), body);
  }

  @Get('tasks/:id') @Header('Cache-Control', 'no-store')
  @AccountApiKeyScopes(AI_GENERATE_SCOPE)
  @RateLimit({ limiter: 'api-default', keyExtractor: '#userId' })
  get(@Req() req: AIRequest, @Param('id') id: string) { return this.tasks.get(req.user.id, id); }
}
