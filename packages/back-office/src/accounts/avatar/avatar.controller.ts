import {
  Controller, Delete, Get, HttpCode, HttpException, Inject, Injectable, Optional, Post, Query, Req, Res, ServiceUnavailableException, StreamableFile, UploadedFile,
  UseGuards, UseInterceptors, type CallHandler, type ExecutionContext, type NestInterceptor,
} from '@nestjs/common';
import { Permissions } from '@zucker-framework/auth';
import { AccessLogger } from '@zucker-framework/logging';
import { RateLimit, RateLimitGuard } from '@zucker-framework/rate-limiter';
import { assertAccountOrigin } from '../account-security';
import { accountOrigins, resolveAccountsOptions, type ResolvedAccountsOptions } from '../accounts.options';
import type { AccountAvatarStorage } from '../accounts.ports';
import { ACCOUNTS_AVATAR_STORAGE, ACCOUNTS_AVATAR_UPLOAD, ACCOUNTS_OPTIONS } from '../accounts.tokens';
import { ACCOUNTS_LIMITER, API_DEFAULT_LIMITER } from '../rate-limits';
import { AccountAvatarService, avatarCommand, type UploadedAvatarFile } from './avatar.service';

interface AvatarRequest { user: { id: string }; headers: Record<string, string | string[] | undefined> }
interface AvatarResponse { setHeader(name: string, value: string): void }

/** Delegates multipart parsing to the consumer's interceptor (`ACCOUNTS_AVATAR_UPLOAD`, e.g. `FileInterceptor('file', …)`). */
@Injectable()
export class AccountAvatarUploadInterceptor implements NestInterceptor {
  constructor(@Inject(ACCOUNTS_AVATAR_UPLOAD) private readonly upload: NestInterceptor) {}
  intercept(context: ExecutionContext, next: CallHandler) { return this.upload.intercept(context, next); }
}

/** `/authorize/avatar`: metadata, upload (multipart `file`), removal and PNG content of the signed-in account's avatar. */
@Controller('authorize/avatar')
@Permissions()
@UseGuards(RateLimitGuard)
@RateLimit(ACCOUNTS_LIMITER)
@AccessLogger({ describe: 'Account avatar', ignore: true })
export class AccountAvatarController {
  private readonly origins: ReadonlySet<string>;
  constructor(private readonly avatars: AccountAvatarService, @Inject(ACCOUNTS_AVATAR_STORAGE) private readonly storage: AccountAvatarStorage,
    @Optional() @Inject(ACCOUNTS_OPTIONS) options?: ResolvedAccountsOptions) {
    this.origins = accountOrigins(options ?? resolveAccountsOptions());
  }
  private async result<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch (error) {
      if (error instanceof HttpException) throw error;
      const mapped = this.storage.mapError?.(error);
      if (mapped) throw mapped;
      throw new ServiceUnavailableException('Avatar storage is unavailable; retry the original request');
    }
  }
  private privateResponse(response: AvatarResponse): void { response.setHeader('Cache-Control', 'private, no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); }
  @Get()
  @RateLimit({ limiter: API_DEFAULT_LIMITER, keyExtractor: '#userId' })
  metadata(@Req() request: AvatarRequest, @Res({ passthrough: true }) response: AvatarResponse) {
    this.privateResponse(response); return this.result(() => this.avatars.metadata(request.user.id));
  }
  @Post() @HttpCode(200)
  @UseInterceptors(AccountAvatarUploadInterceptor)
  upload(@Req() request: AvatarRequest, @Res({ passthrough: true }) response: AvatarResponse, @UploadedFile() file?: UploadedAvatarFile) {
    assertAccountOrigin(this.origins, request); this.privateResponse(response);
    return this.result(() => this.avatars.upload(request.user.id, avatarCommand(request.headers['idempotency-key'], request.headers['if-match']), file));
  }
  @Delete() @HttpCode(200)
  remove(@Req() request: AvatarRequest, @Res({ passthrough: true }) response: AvatarResponse) {
    assertAccountOrigin(this.origins, request); this.privateResponse(response);
    return this.result(() => this.avatars.remove(request.user.id, avatarCommand(request.headers['idempotency-key'], request.headers['if-match'])));
  }
  @Get('content')
  @RateLimit({ limiter: API_DEFAULT_LIMITER, keyExtractor: '#userId' })
  content(@Req() request: AvatarRequest, @Query() query: Record<string, unknown>, @Res({ passthrough: true }) response: AvatarResponse) {
    this.privateResponse(response);
    if (Object.keys(query).length !== 1 || typeof query.revision !== 'string' || !/^(0|[1-9][0-9]{0,9})$/.test(query.revision)) throw new HttpException('An avatar revision is required', 400);
    const revision = Number(query.revision);
    if (!Number.isSafeInteger(revision) || revision > 2147483647) throw new HttpException('Invalid avatar revision', 400);
    return this.result(async () => new StreamableFile(await this.avatars.content(request.user.id, revision), { type: 'image/png', disposition: 'inline; filename="avatar.png"' }));
  }
}
