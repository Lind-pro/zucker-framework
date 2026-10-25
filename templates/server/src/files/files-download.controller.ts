import { BadRequestException, CanActivate, Controller, ExecutionContext, Get, HttpCode, Injectable, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Permissions, Public } from '@zucker-framework/auth';
import { RateLimit, RateLimitGuard } from '@zucker-framework/rate-limiter';
import { FilesDownloadService } from './files-download.service';
import { fileAttachment, fileResult, type DownloadResponse } from './files-http';
const DOWNLOAD_TOKEN = Symbol('PRIVATE_FILE_DOWNLOAD_TOKEN');
interface TicketRequest { method?: string; query?: Record<string, unknown>; body?: unknown; url?: string; originalUrl?: string; [DOWNLOAD_TOKEN]?: string }
/** Runs before access-log interceptors; completion/rejection loggers also see query-free URLs. */
@Injectable()
export class FileDownloadPrivacyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<TicketRequest>(), query = request.query ?? {};
    const body = request.body, objectBody = !!body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
    const queryKeys = Object.keys(query), bodyKeys = objectBody ? Object.keys(objectBody) : [];
    const post = request.method === 'POST', token = post ? objectBody?.token : query.token;
    const valid = post ? !!objectBody && bodyKeys.length === 1 && bodyKeys[0] === 'token' && queryKeys.length === 0
      : queryKeys.length === 1 && queryKeys[0] === 'token' && (body === undefined || !!objectBody && bodyKeys.length === 0);
    const response = context.switchToHttp().getResponse<DownloadResponse>();
    response.setHeader('Cache-Control', 'private, no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer');
    request[DOWNLOAD_TOKEN] = typeof token === 'string' ? token : '';
    if (request.url) request.url = request.url.split('?')[0];
    if (request.originalUrl) request.originalUrl = request.originalUrl.split('?')[0];
    if (objectBody) delete objectBody.token;
    if (!valid || typeof token !== 'string') throw new BadRequestException({ code: 'FILE_DOWNLOAD_INVALID_REQUEST', message: 'Supply exactly one download ticket in the expected request location' });
    return true;
  }
}
@Controller('files')
@Public()
@Permissions()
@UseGuards(FileDownloadPrivacyGuard, RateLimitGuard)
@RateLimit('api-default')
export class FilesDownloadController {
  constructor(private readonly downloads: FilesDownloadService) {}
  @Post(':id/download') @HttpCode(200)
  redeem(@Param('id') id: string, @Req() request: TicketRequest, @Res({ passthrough: true }) response: DownloadResponse) {
    return this.read(id, request, response);
  }
  @Get(':id/download')
  read(@Param('id') id: string, @Req() request: TicketRequest, @Res({ passthrough: true }) response: DownloadResponse) {
    response.setHeader('Cache-Control', 'private, no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    return fileResult(async () => fileAttachment(await this.downloads.read(id, request[DOWNLOAD_TOKEN] ?? ''), response));
  }
}
