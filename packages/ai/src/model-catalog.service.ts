import { listProviderModels } from './provider-models';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { DatabaseAdapter, ModelOperations } from '@zucker-framework/core';

export interface AIModelRecord extends Record<string, unknown> {
  id: string;
  name: string;
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string | null;
  proxyHost?: string | null;
  proxyPort?: number | null;
  isEnabled: boolean;
  isDefault: boolean;
  supportsThinking?: boolean;
  enableThinking?: boolean;
}
export interface AIModelWrite extends Record<string, unknown> {
  name?: string;
  provider?: string;
  modelId?: string;
  apiKey?: string;
  isDefault?: boolean;
  isEnabled?: boolean;
}
export interface AIModelQuery {
  provider?: string;
  isEnabled?: string | boolean;
  isDefault?: string | boolean;
  current?: string | number;
  pageSize?: string | number;
}
export interface AIModelCatalogOptions {
  database: DatabaseAdapter;
  model?: string;
  providers: readonly string[];
  encryptSecret: (secret: string) => string;
  decryptSecret: (secret: string) => string;
  /** Product fields and validation, including ORM-specific JSON-null mapping. */
  extensionFields?: readonly string[];
  normalizeExtensions?: (data: AIModelWrite) => Record<string, unknown>;
  afterChange?: () => void | Promise<void>;
  testConnection?: (model: AIModelRecord) => Promise<{ success: boolean; message: string }>;
  minimumMaxTokens?: number;
}
const TEXT_FIELDS = ['name', 'modelId', 'baseUrl', 'proxyHost', 'description'] as const;
const BOOLEAN_FIELDS = ['isEnabled', 'isDefault', 'supportsThinking', 'enableThinking'] as const;
const NUMBER_FIELDS = ['temperature', 'maxTokens', 'proxyPort'] as const;
const CORE_FIELDS = new Set<string>([
  ...TEXT_FIELDS,
  ...BOOLEAN_FIELDS,
  ...NUMBER_FIELDS,
  'apiKey',
  'provider',
  'scenarios',
  'metadata',
]);

/** Persistent administration of model credentials. Changes never leave the database as a cache-only success. */
@Injectable()
export class AIModelCatalogService {
  constructor(private readonly options: AIModelCatalogOptions) {}
  private models(database = this.options.database) {
    return database.model(this.options.model ?? 'aiModels') as ModelOperations<AIModelRecord>;
  }
  private maskApiKey(secret: string): string {
    try {
      const plain = this.options.decryptSecret(secret);
      return plain.length > 8 ? `${plain.slice(0, 4)}...${plain.slice(-4)}` : '****';
    } catch {
      return '****';
    }
  }
  private present(model: AIModelRecord, full = false) {
    return {
      ...model,
      apiKey: full ? this.options.decryptSecret(model.apiKey) : this.maskApiKey(model.apiKey),
    };
  }
  private boolean(value: string | boolean | undefined) {
    return typeof value === 'boolean'
      ? value
      : value === 'true'
        ? true
        : value === 'false'
          ? false
          : undefined;
  }
  private positive(value: unknown, fallback: number) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  }
  async getAllModels(query: AIModelQuery = {}) {
    const page = this.positive(query.current, 1),
      size = Math.min(200, this.positive(query.pageSize, 10));
    const where: Record<string, unknown> = {};
    if (query.provider && this.options.providers.includes(query.provider))
      where.provider = query.provider;
    for (const key of ['isEnabled', 'isDefault'] as const) {
      const value = this.boolean(query[key]);
      if (value !== undefined) where[key] = value;
    }
    const [data, total] = await Promise.all([
      this.models().findMany({
        where,
        skip: (page - 1) * size,
        take: size,
        orderBy: [{ isDefault: 'desc' }, { isEnabled: 'desc' }, { createdAt: 'desc' }],
      }),
      this.models().count({ where }),
    ]);
    return { data: data.map((model) => this.present(model)), total, success: true };
  }
  private async required(id: string) {
    const model = await this.models().findUnique({ where: { id } });
    if (!model) throw new NotFoundException('AI 模型配置不存在');
    return model;
  }
  async getModelById(id: string, includeApiKey = false) {
    return this.present(await this.required(id), includeApiKey);
  }
  private normalize(data: AIModelWrite, current?: AIModelRecord): Record<string, unknown> {
    if (!data || typeof data !== 'object' || Array.isArray(data))
      throw new BadRequestException('模型配置格式错误');
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(data)) {
      if (!CORE_FIELDS.has(key) && !this.options.extensionFields?.includes(key))
        throw new BadRequestException(`不支持的模型字段: ${key}`);
    }
    for (const key of TEXT_FIELDS) {
      if (data[key] === undefined) continue;
      if (typeof data[key] !== 'string') throw new BadRequestException(`${key} 必须是字符串`);
      out[key] = data[key].trim() || (current ? null : undefined);
    }
    if (!current || data.name !== undefined) {
      if (!out.name) throw new BadRequestException('模型名称不能为空');
    }
    if (!current || data.modelId !== undefined) {
      if (!out.modelId) throw new BadRequestException('模型 ID 不能为空');
    }
    if (data.provider !== undefined) {
      if (!this.options.providers.includes(data.provider))
        throw new BadRequestException('不支持的 AI provider');
      out.provider = data.provider;
    } else if (!current) throw new BadRequestException('provider 不能为空');
    for (const key of BOOLEAN_FIELDS) {
      if (data[key] === undefined) continue;
      if (typeof data[key] !== 'boolean') throw new BadRequestException(`${key} 必须是布尔值`);
      out[key] = data[key];
    }
    for (const key of NUMBER_FIELDS) {
      const value = data[key];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isFinite(value))
        throw new BadRequestException(`${key} 必须是有限数字`);
      if (key === 'temperature' && (value < 0 || value > 2))
        throw new BadRequestException('temperature 必须在 0 到 2 之间');
      if (
        key === 'maxTokens' &&
        (!Number.isInteger(value) || value < (this.options.minimumMaxTokens ?? 1))
      )
        throw new BadRequestException('maxTokens 必须是符合下限的正整数');
      if (key === 'proxyPort' && (!Number.isInteger(value) || value < 1 || value > 65535))
        throw new BadRequestException('proxyPort 必须是合法端口');
      out[key] = value;
    }
    if (data.scenarios !== undefined) {
      if (!Array.isArray(data.scenarios) || !data.scenarios.every((v) => typeof v === 'string'))
        throw new BadRequestException('scenarios 必须是字符串数组');
      out.scenarios = [...new Set(data.scenarios.map((value) => value.trim()).filter(Boolean))];
    }
    if (data.metadata !== undefined) {
      if (!data.metadata || typeof data.metadata !== 'object' || Array.isArray(data.metadata))
        throw new BadRequestException('metadata 必须是对象');
      out.metadata = data.metadata;
    }
    if (data.apiKey !== undefined && typeof data.apiKey !== 'string')
      throw new BadRequestException('API Key 必须是字符串');
    const secret = data.apiKey?.trim();
    if (!current && !secret) throw new BadRequestException('API Key 不能为空');
    if (secret) out.apiKey = this.options.encryptSecret(secret);
    if (!(out.supportsThinking ?? current?.supportsThinking)) out.enableThinking = false;
    if ((out.isDefault ?? current?.isDefault) && (out.isEnabled ?? current?.isEnabled) === false)
      throw new BadRequestException('不能将禁用的模型设置为默认');
    return { ...out, ...this.options.normalizeExtensions?.(data) };
  }
  private async assertUniqueName(name: unknown, id?: string) {
    if (typeof name !== 'string') return;
    const existing = await this.models().findUnique({ where: { name } });
    if (existing && existing.id !== id)
      throw new BadRequestException(`已存在同名模型配置 "${name}"，请改用其他名称`);
  }
  async createModel(data: AIModelWrite) {
    const normalized = this.normalize(data);
    await this.assertUniqueName(normalized.name);
    const model = await this.options.database.$transaction(async (database) => {
      const models = this.models(database);
      if (normalized.isDefault)
        await models.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
      return models.create({ data: normalized });
    });
    await this.options.afterChange?.();
    return this.present(model);
  }
  async updateModel(id: string, data: AIModelWrite) {
    const current = await this.required(id);
    const normalized = this.normalize(data, current);
    await this.assertUniqueName(normalized.name, id);
    const updated = await this.options.database.$transaction(async (database) => {
      const models = this.models(database);
      if (normalized.isDefault)
        await models.updateMany({
          where: { isDefault: true, id: { not: id } },
          data: { isDefault: false },
        });
      return models.update({ where: { id }, data: normalized });
    });
    await this.options.afterChange?.();
    return this.present(updated);
  }
  async deleteModel(id: string) {
    const current = await this.required(id);
    if (current.isDefault)
      throw new BadRequestException('不能删除默认模型，请先设置其他模型为默认');
    await this.models().delete({ where: { id } });
    await this.options.afterChange?.();
    return { success: true, message: '删除成功' };
  }
  async setDefaultModel(id: string) {
    return this.updateModel(id, { isDefault: true });
  }
  async getDefaultModel() {
    const [model] = await this.models().findMany({
      where: { isEnabled: true },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      take: 1,
    });
    if (!model) throw new NotFoundException('没有可用的 AI 模型配置');
    return this.present(model);
  }
  /** @experimental Discover names without exposing the persisted credential. */
  async getAvailableModels(id: string) {
    const model = await this.required(id);
    return listProviderModels({
      provider: model.provider,
      apiKey: this.options.decryptSecret(model.apiKey),
      baseUrl: typeof model.baseUrl === 'string' ? model.baseUrl : undefined,
      proxyHost: typeof model.proxyHost === 'string' ? model.proxyHost : undefined,
      proxyPort: typeof model.proxyPort === 'number' ? model.proxyPort : undefined,
    });
  }
  async testModelConnection(id: string) {
    const model = await this.required(id);
    if (!this.options.testConnection)
      return { success: false, message: '未配置连接检测，尚未验证模型连通性' };
    return this.options.testConnection(this.present(model, true));
  }
}
