import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Header, HttpCode, Inject, Param, Post, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Permissions } from '@zucker-framework/auth';
import { RateLimit, RateLimitGuard } from '@zucker-framework/rate-limiter';
import { FILES_OPTIONS, MAX_FILE_BYTES, type FilesOptions } from './files.config';
import { FILES_TRANSFER_OPTIONS, type FilesTransferOptions } from './files-transfer.config';
import { FilesDownloadService } from './files-download.service';
import { FilesImportService } from './files-import.service';
import { fileAttachment, fileResult, type DownloadResponse } from './files-http';
import { FilesService, publicFileAsset, type UploadedPrivateFile } from './files.service';
interface FileRequest { user: { id: string; sid: string }; headers: Record<string, string | string[] | undefined> }
@Controller('files')
@Permissions()
@UseGuards(RateLimitGuard)
@RateLimit({ limiter: 'api-default', keyExtractor: '#userId' })
export class FilesController {
  private readonly origins = new Set((process.env.ACCOUNT_ORIGINS ?? 'http://localhost:4201,http://localhost:4202').split(',').map(value => value.trim()));
  constructor(private readonly files: FilesService, private readonly downloads: FilesDownloadService, private readonly imports: FilesImportService,
    @Inject(FILES_OPTIONS) private readonly limits: FilesOptions, @Inject(FILES_TRANSFER_OPTIONS) private readonly transfers: FilesTransferOptions) {}
  private origin(req: FileRequest) {
    if (typeof req.headers.origin !== 'string' || !this.origins.has(req.headers.origin) || req.headers['sec-fetch-site'] === 'cross-site') throw new ForbiddenException('Untrusted file request origin');
  }
  @Get() @Header('Cache-Control', 'private, no-store')
  list(@Req() req: FileRequest, @Query() query: Record<string, unknown>) {
    if (Object.keys(query).some(key => key !== 'page') || query.page !== undefined && typeof query.page !== 'string') throw new BadRequestException('Invalid file list query');
    return fileResult(async () => ({ ...await this.files.list(req.user.id, query.page as string | undefined), limits: { maxFileBytes: this.limits.maxObjectBytes, urlImportEnabled: this.transfers.importAllowedHosts.length > 0 } }));
  }
  @Post() @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 0, parts: 2 } }))
  upload(@Req() req: FileRequest, @UploadedFile() file?: UploadedPrivateFile) {
    this.origin(req); const key = req.headers['idempotency-key'];
    return fileResult(async () => publicFileAsset(await this.files.upload(req.user.id, typeof key === 'string' ? key : undefined, file)));
  }
  @Post('import') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  import(@Req() req: FileRequest, @Body() body: unknown) {
    this.origin(req); const key = req.headers['idempotency-key'];
    return fileResult(async () => publicFileAsset(await this.imports.import(req.user.id, typeof key === 'string' ? key : undefined, body)));
  }
  @Post(':id/download-url') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  downloadUrl(@Req() req: FileRequest, @Param('id') id: string, @Body() body: unknown) {
    this.origin(req);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new BadRequestException('Download tickets do not accept parameters');
    return fileResult(() => this.downloads.create(req.user.id, req.user.sid, id));
  }
  @Get('requests/:key') @Header('Cache-Control', 'private, no-store')
  inspectRequest(@Req() req: FileRequest, @Param('key') key: string) { return fileResult(async () => publicFileAsset(await this.files.inspectRequest(req.user.id, key))); }
  @Get(':id') @Header('Cache-Control', 'private, no-store')
  inspect(@Req() req: FileRequest, @Param('id') id: string) { return fileResult(async () => publicFileAsset(await this.files.inspect(req.user.id, id))); }
  @Get(':id/content')
  read(@Req() req: FileRequest, @Param('id') id: string, @Res({ passthrough: true }) response: DownloadResponse) { return fileResult(async () => fileAttachment(await this.files.read(req.user.id, id), response)); }
  @Delete(':id') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  delete(@Req() req: FileRequest, @Param('id') id: string) { this.origin(req); return fileResult(async () => publicFileAsset(await this.files.delete(req.user.id, id))); }
  @Post(':id/recover') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
  recover(@Req() req: FileRequest, @Param('id') id: string) { this.origin(req); return fileResult(async () => publicFileAsset(await this.files.recover(req.user.id, id))); }
}
