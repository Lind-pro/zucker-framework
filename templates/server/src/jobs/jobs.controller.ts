import { Controller, ForbiddenException, Get, HttpCode, HttpException, Param, Post, Body, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { Permissions } from '@zucker-framework/auth';
import { RateLimit, RateLimitGuard } from '@zucker-framework/rate-limiter';
import { JobsService } from './jobs.service';

interface JobRequest { user: { id: string }; headers: Record<string, string | string[] | undefined> }
@Controller('jobs')
@Permissions()
@UseGuards(RateLimitGuard)
@RateLimit({ limiter: 'api-default', keyExtractor: '#userId' })
export class JobsController {
  private readonly origins = new Set((process.env.ACCOUNT_ORIGINS ?? 'http://localhost:4201,http://localhost:4202').split(',').map(value => value.trim()));
  constructor(private readonly jobs: JobsService) {}
  private origin(request: JobRequest) {
    if (typeof request.headers.origin !== 'string' || !this.origins.has(request.headers.origin) || request.headers['sec-fetch-site'] === 'cross-site')
      throw new ForbiddenException('Untrusted job request origin');
  }
  private async result<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) { if (error instanceof HttpException) throw error; throw new ServiceUnavailableException('Durable job storage is unavailable'); }
  }
  @Post() @HttpCode(202)
  submit(@Req() request: JobRequest, @Body() body: unknown) {
    this.origin(request); const key = request.headers['idempotency-key'];
    return this.result(() => this.jobs.submitForUser(request.user.id, typeof key === 'string' ? key : undefined, body));
  }
  @Get()
  list(@Req() request: JobRequest) { return this.result(() => this.jobs.list(request.user.id)); }
  @Get(':id')
  get(@Req() request: JobRequest, @Param('id') id: string) { return this.result(() => this.jobs.get(request.user.id, id)); }
  @Get(':id/record')
  record(@Req() request: JobRequest, @Param('id') id: string) { return this.result(() => this.jobs.record(request.user.id, id)); }
  @Post(':id/cancel') @HttpCode(200)
  cancel(@Req() request: JobRequest, @Param('id') id: string) {
    this.origin(request); return this.result(() => this.jobs.cancel(request.user.id, id));
  }
}
