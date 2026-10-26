import { BadRequestException, Injectable, NotFoundException, Logger } from '@nestjs/common';
import type { DatabaseAdapter, ModelOperations } from '@zucker-framework/core';
import { createHash, randomBytes } from 'node:crypto';

export interface ApiKeyRecord {
  id: string;
  userId: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  scopes: string[];
  rateLimit: number;
  dailyLimit: number | null;
  monthlyLimit: number | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  isActive: boolean;
  lastUsedAt: Date | null;
  usageCount: number;
  createdAt: Date;
}

export interface ApiKeyRateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
}

export interface ApiKeyServiceOptions {
  modelName: string;
  usageModelName: string;
  keyPrefix: string;
  displayPrefixLength?: number;
  defaultScopes: string[];
  defaultRateLimit: number;
  consumeRateLimit(keyId: string, limit: number): Promise<ApiKeyRateLimitResult>;
  messages?: Partial<Record<'invalidFormat' | 'notFound' | 'disabled' | 'revoked' | 'expired', string>>;
}

export interface CreateApiKeyParams {
  userId: string;
  name: string;
  scopes?: string[];
  rateLimit?: number;
  dailyLimit?: number;
  monthlyLimit?: number;
  expiresAt?: Date;
}

export interface ApiKeyValidationResult {
  isValid: boolean;
  userId?: string;
  keyId?: string;
  scopes?: string[];
  errorMessage?: string;
}

/**
 * API Key 服务
 */
@Injectable()
export class ApiKeyService<T extends ApiKeyRecord = ApiKeyRecord> {
  private readonly logger = new Logger(ApiKeyService.name);

  constructor(
    private readonly database: DatabaseAdapter,
    readonly options: ApiKeyServiceOptions,
  ) {}

  /**
   * 生成 API Key
   * 密钥前缀由消费者配置；仅存储SHA-256摘要。
   */
  private generateApiKey(): { key: string; prefix: string; hash: string } {
    const key = `${this.options.keyPrefix}${randomBytes(24).toString('base64url')}`;
    const prefix = key.substring(0, this.options.displayPrefixLength ?? 12) + '...';
    const hash = createHash('sha256').update(key).digest('hex');

    return { key, prefix, hash };
  }

  /**
   * 创建 API Key
   * 注意：完整的 key 只返回一次，之后无法再获取
   */
  async createApiKey(params: CreateApiKeyParams): Promise<{ apiKey: Pick<T, 'id' | 'name' | 'keyPrefix' | 'scopes' | 'rateLimit' | 'dailyLimit' | 'monthlyLimit' | 'expiresAt' | 'createdAt'>; secretKey: string }> {
    const { userId, name, scopes, rateLimit, dailyLimit, monthlyLimit, expiresAt } = params;

    // 生成 key
    const { key, prefix, hash } = this.generateApiKey();

    const apiKey = await this.model().create({
      data: {
        userId,
        name,
        keyPrefix: prefix,
        keyHash: hash,
        scopes: scopes ?? this.options.defaultScopes,
        rateLimit: rateLimit ?? this.options.defaultRateLimit,
        dailyLimit,
        monthlyLimit,
        expiresAt,
      },
    });

    this.logger.log(`API key created: id=${apiKey.id}`);

    return {
      apiKey: {
        id: apiKey.id,
        name: apiKey.name,
        keyPrefix: apiKey.keyPrefix,
        scopes: apiKey.scopes,
        rateLimit: apiKey.rateLimit,
        dailyLimit: apiKey.dailyLimit,
        monthlyLimit: apiKey.monthlyLimit,
        expiresAt: apiKey.expiresAt,
        createdAt: apiKey.createdAt,
      },
      secretKey: key, // 完整的 key，只返回这一次
    };
  }

  /**
   * 验证 API Key
   */
  async validateApiKey(key: string): Promise<ApiKeyValidationResult> {
    if (!key || !key.startsWith(this.options.keyPrefix)) {
      return { isValid: false, errorMessage: this.message('invalidFormat') };
    }

    const hash = createHash('sha256').update(key).digest('hex');

    const [apiKey] = await this.model().findMany({
      where: { keyHash: hash }, take: 1,
    });

    if (!apiKey) {
      return { isValid: false, errorMessage: this.message('notFound') };
    }

    if (!apiKey.isActive) {
      return { isValid: false, errorMessage: this.message('disabled') };
    }

    if (apiKey.revokedAt) {
      return { isValid: false, errorMessage: this.message('revoked') };
    }

    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
      return { isValid: false, errorMessage: this.message('expired') };
    }

    // Authorization and usage touch share an atomic active/revocation predicate.
    const touched = await this.model().updateMany({
      where: {
        id: apiKey.id, keyHash: hash, isActive: true, revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gte: new Date() } }],
      },
      data: { lastUsedAt: new Date(), usageCount: { increment: 1 } },
    });
    if (touched.count !== 1) return { isValid: false, errorMessage: this.message('revoked') };

    return {
      isValid: true,
      userId: apiKey.userId,
      keyId: apiKey.id,
      scopes: apiKey.scopes,
    };
  }

  /**
   * 检查速率限制
   */
  async checkRateLimit(keyId: string): Promise<{ allowed: boolean; remaining: number; resetAt: Date }> {
    const apiKey = await this.model().findUnique({ where: { id: keyId } });
    if (!apiKey) {
      return { allowed: false, remaining: 0, resetAt: new Date() };
    }

    return this.options.consumeRateLimit(keyId, apiKey.rateLimit);
  }

  /**
   * 获取用户的 API Key 列表
   */
  async getUserApiKeys(userId: string): Promise<Pick<T, 'id' | 'name' | 'keyPrefix' | 'scopes' | 'rateLimit' | 'dailyLimit' | 'monthlyLimit' | 'lastUsedAt' | 'usageCount' | 'isActive' | 'expiresAt' | 'createdAt'>[]> {
    return this.model().findMany({
      where: { userId, revokedAt: null },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        scopes: true,
        rateLimit: true,
        dailyLimit: true,
        monthlyLimit: true,
        lastUsedAt: true,
        usageCount: true,
        isActive: true,
        expiresAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * 获取 API Key 详情
   */
  async getApiKey(keyId: string, userId: string): Promise<Pick<T, 'id' | 'name' | 'keyPrefix' | 'scopes' | 'rateLimit' | 'dailyLimit' | 'monthlyLimit' | 'lastUsedAt' | 'usageCount' | 'isActive' | 'expiresAt' | 'createdAt' | 'userId'>> {
    const apiKey = await this.model().findUnique({
      where: { id: keyId },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        scopes: true,
        rateLimit: true,
        dailyLimit: true,
        monthlyLimit: true,
        lastUsedAt: true,
        usageCount: true,
        isActive: true,
        expiresAt: true,
        createdAt: true,
        userId: true,
      },
    });

    if (!apiKey || apiKey.userId !== userId) {
      throw new NotFoundException(this.message('notFound'));
    }

    return apiKey;
  }

  /**
   * 更新 API Key
   */
  async updateApiKey(
    keyId: string,
    userId: string,
    data: { name?: string; scopes?: string[]; rateLimit?: number; isActive?: boolean },
  ): Promise<T> {
    const apiKey = await this.model().findUnique({ where: { id: keyId } });

    if (!apiKey || apiKey.userId !== userId) {
      throw new NotFoundException(this.message('notFound'));
    }

    return this.model().update({
      where: { id: keyId, userId },
      data,
    });
  }

  /** Owner metadata edit on one still-active key; never rotates or returns credential material. */
  async renameApiKey(keyId: string, userId: string, name: string): Promise<{ id: string; name: string }> {
    if (typeof keyId !== 'string' || !keyId.trim() || typeof userId !== 'string' || !userId.trim())
      throw new NotFoundException(this.message('notFound'));
    if (typeof name !== 'string' || !name.trim()) throw new BadRequestException('API key name is required');
    const normalized = name.trim();
    const changed = await this.model().updateMany({ where: { id: keyId, userId, isActive: true, revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, data: { name: normalized } });
    if (changed.count !== 1) throw new NotFoundException(this.message('notFound'));
    return { id: keyId, name: normalized };
  }

  /**
   * 撤销 API Key
   */
  async revokeApiKey(keyId: string, userId: string): Promise<void> {
    const apiKey = await this.model().findUnique({ where: { id: keyId } });

    if (!apiKey || apiKey.userId !== userId) {
      throw new NotFoundException(this.message('notFound'));
    }

    await this.model().update({
      where: { id: keyId, userId },
      data: {
        isActive: false,
        revokedAt: new Date(),
      },
    });

    this.logger.log(`API key revoked: id=${apiKey.id}`);
  }

  /**
   * 记录 API Key 使用
   */
  async logUsage(
    keyId: string,
    userId: string,
    endpoint: string,
    method: string,
    statusCode: number,
    responseTime: number,
    errorMessage?: string,
  ): Promise<void> {
    await this.usage().create({
      data: {
        apiKeyId: keyId,
        userId,
        endpoint,
        method,
        statusCode,
        responseTime,
        errorMessage,
      },
    });
  }

  /**
   * 获取 API Key 使用统计
   */
  async getUsageStats(keyId: string, userId: string): Promise<{
    totalRequests: number;
    successRequests: number;
    errorRequests: number;
    successRate: string | number;
    avgResponseTime: number | null;
  }> {
    const apiKey = await this.model().findUnique({ where: { id: keyId } });

    if (!apiKey || apiKey.userId !== userId) {
      throw new NotFoundException(this.message('notFound'));
    }

    // 获取最近24小时的使用统计
    const oneDayAgo = new Date();
    oneDayAgo.setHours(oneDayAgo.getHours() - 24);

    const usage = this.usage();
    if (!usage.aggregate) throw new Error('API key usage statistics require aggregate support');
    const [totalRequests, successRequests, avgResponseTime] = await Promise.all([
      this.usage().count({
        where: { apiKeyId: keyId, timestamp: { gte: oneDayAgo } },
      }),
      this.usage().count({
        where: { apiKeyId: keyId, timestamp: { gte: oneDayAgo }, statusCode: { lt: 400 } },
      }),
      usage.aggregate({
        where: { apiKeyId: keyId, timestamp: { gte: oneDayAgo } },
        _avg: { responseTime: true },
      }),
    ]);

    const average = avgResponseTime._avg as { responseTime?: number | null } | undefined;
    return {
      totalRequests,
      successRequests,
      errorRequests: totalRequests - successRequests,
      successRate: totalRequests > 0 ? ((successRequests / totalRequests) * 100).toFixed(2) : 0,
      avgResponseTime: average?.responseTime || 0,
    };
  }
  private model(): ModelOperations<T> {
    return this.database.model(this.options.modelName) as ModelOperations<T>;
  }

  private usage(): ModelOperations {
    return this.database.model(this.options.usageModelName);
  }

  private message(code: keyof NonNullable<ApiKeyServiceOptions['messages']>): string {
    const defaults = {
      invalidFormat: 'Invalid API key format', notFound: 'API key not found',
      disabled: 'API key disabled', revoked: 'API key revoked', expired: 'API key expired',
    };
    return this.options.messages?.[code] ?? defaults[code];
  }
}
