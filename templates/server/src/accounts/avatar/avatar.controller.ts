import { Controller, Delete, ForbiddenException, Get, HttpCode, HttpException, Post, Query, Req, Res, ServiceUnavailableException, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Permissions } from '@zucker-framework/auth';
import { AccessLogger } from '@zucker-framework/logging';
import { FileAssetError, StorageTransferError } from '@zucker-framework/storage';
import { RateLimit, RateLimitGuard } from '@zucker-framework/rate-limiter';
import type { UploadedPrivateFile } from '../../files/files.service';
import { AccountAvatarService, AVATAR_MAX_INPUT_BYTES, avatarCommand } from './avatar.service';

interface AvatarRequest { user: { id: string }; headers: Record<string, string | string[] | undefined> }
interface AvatarResponse { setHeader(name: string, value: string): void }
@Controller('authorize/avatar')
@Permissions()
@UseGuards(RateLimitGuard)
@RateLimit('accounts')
@AccessLogger({ describe: 'Account avatar', ignore: true })
export class AccountAvatarController {
  private readonly origins = new Set((process.env.ACCOUNT_ORIGINS ?? 'http://localhost:4201,http://localhost:4202').split(',').map(value => value.trim()));
  constructor(private readonly avatars: AccountAvatarService) {}
  private origin(request: AvatarRequest): void {
    if (typeof request.headers.origin !== 'string' || !this.origins.has(request.headers.origin) || request.headers['sec-fetch-site'] === 'cross-site') throw new ForbiddenException('Untrusted account request origin');
  }
  private async result<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof FileAssetError && ['IDEMPOTENCY_CONFLICT', 'ASSET_DELETED', 'CONCURRENT_CHANGE'].includes(error.code))
        throw new HttpException('Avatar request conflicts with an existing file', 409);
      if (error instanceof StorageTransferError && error.code === 'OBJECT_SIZE_OUT_OF_BOUNDS') throw new HttpException('Avatar file exceeds the configured size limit', 413);
      throw new ServiceUnavailableException('Avatar storage is unavailable; retry the original request');
    }
  }
  private privateResponse(response: AvatarResponse): void { response.setHeader('Cache-Control', 'private, no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); }
  @Get()
  @RateLimit({ limiter: 'api-default', keyExtractor: '#userId' })
  metadata(@Req() request: AvatarRequest, @Res({ passthrough: true }) response: AvatarResponse) {
    this.privateResponse(response); return this.result(() => this.avatars.metadata(request.user.id));
  }
  @Post() @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: AVATAR_MAX_INPUT_BYTES, files: 1, fields: 0, parts: 2 } }))
  upload(@Req() request: AvatarRequest, @Res({ passthrough: true }) response: AvatarResponse, @UploadedFile() file?: UploadedPrivateFile) {
    this.origin(request); this.privateResponse(response);
    return this.result(() => this.avatars.upload(request.user.id, avatarCommand(request.headers['idempotency-key'], request.headers['if-match']), file));
  }
  @Delete() @HttpCode(200)
  remove(@Req() request: AvatarRequest, @Res({ passthrough: true }) response: AvatarResponse) {
    this.origin(request); this.privateResponse(response);
    return this.result(() => this.avatars.remove(request.user.id, avatarCommand(request.headers['idempotency-key'], request.headers['if-match'])));
  }
  @Get('content')
  @RateLimit({ limiter: 'api-default', keyExtractor: '#userId' })
  content(@Req() request: AvatarRequest, @Query() query: Record<string, unknown>, @Res({ passthrough: true }) response: AvatarResponse) {
    this.privateResponse(response);
    if (Object.keys(query).length !== 1 || typeof query.revision !== 'string' || !/^(0|[1-9][0-9]{0,9})$/.test(query.revision)) throw new HttpException('An avatar revision is required', 400);
    const revision = Number(query.revision);
    if (!Number.isSafeInteger(revision) || revision > 2147483647) throw new HttpException('Invalid avatar revision', 400);
    return this.result(async () => new StreamableFile(await this.avatars.content(request.user.id, revision), { type: 'image/png', disposition: 'inline; filename="avatar.png"' }));
  }
}
