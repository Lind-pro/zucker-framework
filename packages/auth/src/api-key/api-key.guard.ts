import {
  Inject,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ApiKeyService } from './api-key.service';

export const API_KEY_GUARD_OPTIONS = Symbol('API_KEY_GUARD_OPTIONS');

export interface ApiKeyGuardOptions {
  /** Allows other authentication guards to handle a request without this key prefix. */
  allowMissingKey?: boolean;
  headerName?: string;
  rateLimitMessage?: string;
  missingKeyMessage?: string;
}

interface ApiKeyRequest {
  headers: Record<string, string | string[] | undefined>;
  get?(name: string): string | undefined;
  path: string;
  method: string;
  user?: unknown;
  apiKey?: { id: string; scopes: string[] };
}
interface ApiKeyResponse {
  statusCode?: number;
  setHeader(name: string, value: string | number): unknown;
  on(event: 'finish', listener: () => void): unknown;
}

/** Header-only API key authentication and rate-limit enforcement. No query-string secrets. */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(
    @Inject(ApiKeyService) private readonly apiKeyService: ApiKeyService,
    @Optional()
    @Inject(API_KEY_GUARD_OPTIONS)
    private readonly options: ApiKeyGuardOptions = {},
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ApiKeyRequest>();
    const secret = this.extractApiKey(request);
    if (!secret) {
      if (this.options.allowMissingKey) return true;
      throw new UnauthorizedException(this.options.missingKeyMessage ?? 'API key required');
    }
    const startedAt = Date.now();
    const validation = await this.apiKeyService.validateApiKey(secret);
    if (!validation.isValid || !validation.keyId || !validation.userId) {
      throw new UnauthorizedException(validation.errorMessage);
    }
    const rateLimit = await this.apiKeyService.checkRateLimit(validation.keyId);
    if (!rateLimit.allowed) {
      throw new UnauthorizedException(
        this.options.rateLimitMessage ?? 'Request rate limit exceeded',
      );
    }
    const response = context.switchToHttp().getResponse<ApiKeyResponse>();
    response.setHeader('X-RateLimit-Remaining', rateLimit.remaining);
    response.setHeader('X-RateLimit-Reset', rateLimit.resetAt.toISOString());
    request.user = { id: validation.userId };
    request.apiKey = { id: validation.keyId, scopes: validation.scopes ?? [] };

    const { keyId, userId } = validation;
    response.on('finish', () => {
      void this.apiKeyService
        .logUsage(
          keyId,
          userId,
          request.path,
          request.method,
          response.statusCode || 200,
          Date.now() - startedAt,
        )
        .catch(() => {
          // Audit logging is best effort; never leak URLs, credentials or a rejected promise.
          this.logger.warn('API key usage persistence failed');
        });
    });
    return true;
  }

  private extractApiKey(request: ApiKeyRequest): string | null {
    const prefix = this.apiKeyService.options.keyPrefix;
    const authorization = request.headers.authorization;
    if (typeof authorization === 'string' && authorization.startsWith(`Bearer ${prefix}`)) {
      return authorization.substring(7);
    }
    const header = this.options.headerName ?? 'x-api-key';
    const key = request.get?.(header) ?? request.headers[header.toLowerCase()];
    return typeof key === 'string' && key.startsWith(prefix) ? key : null;
  }
}
