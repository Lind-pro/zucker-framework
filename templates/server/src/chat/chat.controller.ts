import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Permissions } from '@zucker-framework/auth';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { createReadOnlyRecordReader } from '@zucker-framework/admin';
import { RateLimit, RateLimitGuard } from '@zucker-framework/rate-limiter';
import { ApplicationDatabase } from '../database';
import type { RateLimiterFragment } from '../rate-limits';
import { assertTrustedOrigin, trustedOrigins } from '../ai-tasks/ai-tasks.controller';
import { ChatService, type SseResponse } from './chat.service';

/** Per-user chat turns (each starts a metered provider call). */
export const CHAT_LIMITER = 'chat';
export const CHAT_RATE_LIMITERS: RateLimiterFragment = Object.freeze({ [CHAT_LIMITER]: { points: 30, duration: 60 } });

interface ChatRequest { user: { id: string }; headers: Record<string, string | string[] | undefined> }

@Controller('chat')
@Permissions()
@UseGuards(RateLimitGuard)
@RateLimit({ limiter: 'api-default', keyExtractor: '#userId' })
export class ChatController {
  private readonly origins = trustedOrigins();
  constructor(private readonly chats: ChatService) {}

  @Post() @HttpCode(201) @Header('Cache-Control', 'private, no-store')
  create(@Req() req: ChatRequest, @Body() body: unknown) {
    assertTrustedOrigin(this.origins, req);
    return this.chats.create(req.user.id, body);
  }

  @Get() @Header('Cache-Control', 'private, no-store')
  list(@Req() req: ChatRequest, @Query() query: Record<string, unknown>) { return this.chats.list(req.user.id, query); }

  @Get(':id') @Header('Cache-Control', 'private, no-store')
  get(@Req() req: ChatRequest, @Param('id') id: string) { return this.chats.get(req.user.id, id); }

  @Delete(':id') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  remove(@Req() req: ChatRequest, @Param('id') id: string) {
    assertTrustedOrigin(this.origins, req);
    return this.chats.delete(req.user.id, id);
  }

  /** SSE: `start`, `reasoning`*, `delta`*, then `done` or `error`. Pre-stream failures are JSON statuses. */
  @Post(':id/messages')
  @RateLimit({ limiter: CHAT_LIMITER, keyExtractor: '#userId' })
  async message(@Req() req: ChatRequest, @Param('id') id: string, @Body() body: unknown, @Res() res: SseResponse) {
    assertTrustedOrigin(this.origins, req);
    await this.chats.stream(req.user.id, id, body, res);
  }
}

const chatRecords = createReadOnlyRecordReader({
  model: 'chats',
  filters: ['ownerId'],
  orderBy: { updatedAt: 'desc' },
  maxPageSize: 100,
  // Session metadata only; message content is never part of the management projection.
  projection: ['id', 'ownerId', 'title', 'model', 'messageCount', 'cost', 'updatedAt', 'providerId', 'createdAt'],
});

/** Read-only chat sessions for the back office: `{ data, total, page, pageSize }`, `/:id` -> row or null. */
@Controller('management/chats')
@UseGuards(RateLimitGuard)
@RateLimit({ limiter: 'api-default', keyExtractor: '#userId' })
export class ChatsManagementController {
  constructor(@Inject(DATABASE_ADAPTER) private readonly database: ApplicationDatabase) {}
  @Get() @Permissions('chats:query') @Header('Cache-Control', 'private, no-store')
  list(@Query() query: Record<string, unknown>) { return chatRecords.findAll(this.database, query); }
  @Get(':id') @Permissions('chats:query') @Header('Cache-Control', 'private, no-store')
  get(@Param('id') id: string) { return chatRecords.findOne(this.database, id); }
}
