import { BadRequestException, Body, Controller, Get, Header, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Permissions } from '@zucker-framework/auth';
import { RateLimit, RateLimitGuard } from '@zucker-framework/rate-limiter';
import type { RateLimiterFragment } from '../rate-limits';
import { assertTrustedOrigin, trustedOrigins } from '../ai-tasks/ai-tasks.controller';
import { InboxService } from './inbox.service';

/** Unread-badge polling (every 60 s per open tab), per user; kept apart from `api-default`. */
export const INBOX_READ_LIMITER = 'inbox-read';
export const INBOX_RATE_LIMITERS: RateLimiterFragment = Object.freeze({ [INBOX_READ_LIMITER]: { points: 120, duration: 60 } });

interface InboxRequest { user: { id: string }; headers: Record<string, string | string[] | undefined> }

function assertEmptyBody(body: unknown): void {
  // Writes take no input; anything but an empty object/absent body is a client error.
  if (body !== undefined && body !== null && (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length))
    throw new BadRequestException('This request takes no body');
}

/** The signed-in user's notifications. Every query is scoped to `req.user.id`; another user's id is 404. */
@Controller('inbox')
@Permissions()
@UseGuards(RateLimitGuard)
@RateLimit({ limiter: 'api-default', keyExtractor: '#userId' })
export class InboxController {
  private readonly origins = trustedOrigins();
  constructor(private readonly inbox: InboxService) {}

  /** `{ data: [{ id, type, params, href, isRead, readAt, createdAt }], total, unreadCount }`. */
  @Get() @Header('Cache-Control', 'private, no-store')
  list(@Req() req: InboxRequest, @Query() query: Record<string, unknown>) { return this.inbox.list(req.user.id, query); }

  @Get('unread-count') @Header('Cache-Control', 'private, no-store')
  @RateLimit({ limiter: INBOX_READ_LIMITER, keyExtractor: '#userId' })
  unreadCount(@Req() req: InboxRequest) { return this.inbox.unreadCount(req.user.id); }

  @Post('read-all') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  readAll(@Req() req: InboxRequest, @Body() body: unknown) {
    assertTrustedOrigin(this.origins, req);
    assertEmptyBody(body);
    return this.inbox.markAllRead(req.user.id);
  }

  @Post(':id/read') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  read(@Req() req: InboxRequest, @Param('id') id: string, @Body() body: unknown) {
    assertTrustedOrigin(this.origins, req);
    assertEmptyBody(body);
    return this.inbox.markRead(req.user.id, id);
  }

  @Post(':id/archive') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  archive(@Req() req: InboxRequest, @Param('id') id: string, @Body() body: unknown) {
    assertTrustedOrigin(this.origins, req);
    assertEmptyBody(body);
    return this.inbox.archive(req.user.id, id);
  }
}
