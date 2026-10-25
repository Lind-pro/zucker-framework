import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  HttpException,
  Param,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { Permissions } from '@zucker-framework/auth';
import { RateLimit, RateLimitGuard } from '@zucker-framework/rate-limiter';
import { ManagementService } from './management.service';
import { ConnectionsService } from './connections.service';
interface ManagementRequest {
  user: { id: string };
  headers: Record<string, string | string[] | undefined>;
}
async function result<T>(work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpException) throw error;
    throw new ServiceUnavailableException('Management data is temporarily unavailable');
  }
}
@Controller('management')
@UseGuards(RateLimitGuard)
@RateLimit({ limiter: 'api-default', keyExtractor: '#userId' })
export class ManagementController {
  private readonly origins = new Set(
    (process.env.ACCOUNT_ORIGINS ?? 'http://localhost:4201,http://localhost:4202')
      .split(',')
      .map((value) => value.trim()),
  );
  constructor(
    private readonly management: ManagementService,
    private readonly connections: ConnectionsService,
  ) {}
  @Get('connections')
  @Permissions('config:query')
  @Header('Cache-Control', 'private, no-store')
  configuration() {
    return result(() => this.connections.inspect());
  }
  @Get('api-keys')
  @Permissions('api-keys:query')
  @Header('Cache-Control', 'private, no-store')
  apiKeys(@Query() query: Record<string, unknown>) {
    return result(() => this.management.list('api-keys', query));
  }
  @Get('orders') @Permissions('billing:query') @Header('Cache-Control', 'private, no-store') orders(
    @Query() query: Record<string, unknown>,
  ) {
    return result(() => this.management.list('orders', query));
  }
  @Get('subscriptions')
  @Permissions('billing:query')
  @Header('Cache-Control', 'private, no-store')
  subscriptions(@Query() query: Record<string, unknown>) {
    return result(() => this.management.list('subscriptions', query));
  }
  @Get('jobs') @Permissions('jobs:query') @Header('Cache-Control', 'private, no-store') jobs(
    @Query() query: Record<string, unknown>,
  ) {
    return result(() => this.management.list('jobs', query));
  }
  @Get('deliveries')
  @Permissions('notification:query')
  @Header('Cache-Control', 'private, no-store')
  deliveries(@Query() query: Record<string, unknown>) {
    return result(() => this.management.list('deliveries', query));
  }
  @Get('files') @Permissions('files:query') @Header('Cache-Control', 'private, no-store') files(
    @Query() query: Record<string, unknown>,
  ) {
    return result(() => this.management.list('files', query));
  }
  @Get('access-logs')
  @Permissions('logging:query')
  @Header('Cache-Control', 'private, no-store')
  accessLogs(@Query() query: Record<string, unknown>) {
    return result(() => this.management.list('access-logs', query));
  }
  @Get('operation-logs')
  @Permissions('logging:query')
  @Header('Cache-Control', 'private, no-store')
  operationLogs(@Query() query: Record<string, unknown>) {
    return result(() => this.management.list('operation-logs', query));
  }
  @Get('credits')
  @Permissions('credit:query')
  @Header('Cache-Control', 'private, no-store')
  credits(@Query() query: Record<string, unknown>) {
    return result(() => this.management.list('credits', query));
  }
  @Get('credits/:ownerId/balance')
  @Permissions('credit:query')
  @Header('Cache-Control', 'private, no-store')
  balance(@Param('ownerId') owner: string) {
    return result(() => this.management.creditBalance(owner));
  }
  @Get('credits/:ownerId/lots')
  @Permissions('credit:query')
  @Header('Cache-Control', 'private, no-store')
  lots(@Param('ownerId') owner: string, @Query() query: Record<string, unknown>) {
    return result(() => this.management.creditLots(owner, query));
  }
  @Post('credits/:ownerId/grants')
  @Permissions('credit:grant')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  grant(@Req() req: ManagementRequest, @Param('ownerId') owner: string, @Body() body: unknown) {
    if (
      typeof req.headers.origin !== 'string' ||
      !this.origins.has(req.headers.origin) ||
      req.headers['sec-fetch-site'] === 'cross-site'
    )
      throw new ForbiddenException('Untrusted management request origin');
    return result(() =>
      this.management.grant(req.user.id, owner, req.headers['idempotency-key'], body),
    );
  }
}
