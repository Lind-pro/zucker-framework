import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import {
  DATABASE_ADAPTER,
  parseTemplateWithMapper,
  type DatabaseAdapter,
} from '@zucker-framework/core';

/** 期望的响应格式（对齐 OpenAI Chat Completions API response_format 字段）*/
export type ResponseFormat = 'json_object' | 'json_array' | 'text' | 'json_schema';

/**
 * 提示词模板定义。
 * 对标 jetlinks PromptTemplate — 管理 AI 提示词模板。
 */
export interface PromptTemplate {
  id: string;
  /** 显示名称（可选）。某些项目用 key 而非 name 作为业务标识 */
  name?: string;
  /** 业务 key（可选）。配合 isActive + version 实现多版本激活模式 */
  key?: string;
  /** 提示词内容，支持 {{variable}} 占位符 */
  content: string;
  /** 系统提示词 */
  systemPrompt?: string;
  /** 模板变量定义 */
  variables?: PromptVariable[];
  /** 分类标签 */
  tags?: string[];
  /** 模板版本 */
  version?: number;
  /** 是否激活（多版本场景下，仅 isActive=true 的版本会被 findActiveByKey 命中）*/
  isActive?: boolean;
  /** 使用的模型 */
  model?: string;
  /** 使用的 provider */
  provider?: string;
  /** 温度参数 */
  temperature?: number;
  /** 最大输出 token */
  maxTokens?: number;
  /** 期望响应格式 */
  responseFormat?: ResponseFormat;
  /** json_schema 模式下的 schema 定义 */
  jsonSchema?: { name?: string; schema: Record<string, unknown>; strict?: boolean };
  createdAt?: Date;
  updatedAt?: Date;
}

/** findActiveByKey 查询参数 */
export interface FindByKeyOptions {
  /** 单 key 查询 */
  key?: string;
  /** 候选 key 列表（支持带前缀，如 ['sections', 'software.sections']）*/
  keys?: string[];
  /** 是否要求 isActive=true，默认 true */
  activeOnly?: boolean;
}

export interface PromptVariable {
  name: string;
  description?: string;
  type: 'string' | 'number' | 'boolean' | 'json';
  required?: boolean;
  defaultValue?: unknown;
}

@Injectable()
export class PromptManager {
  private readonly logger = new Logger(PromptManager.name);
  private readonly cache = new Map<string, PromptTemplate>();

  constructor(@Inject(DATABASE_ADAPTER) @Optional() private readonly db?: DatabaseAdapter) {}

  /** 获取提示词模板 */
  async getTemplate(id: string): Promise<PromptTemplate | null> {
    if (this.cache.has(id)) return this.cache.get(id)!;
    if (!this.db) return null;

    try {
      const record = await this.db.model('promptTemplate').findUnique({ where: { id } });
      if (!record) return null;
      const template = record as unknown as PromptTemplate;
      this.cache.set(id, template);
      return template;
    } catch {
      return null;
    }
  }

  /** 保存提示词模板（upsert） */
  async saveTemplate(template: PromptTemplate): Promise<PromptTemplate> {
    if (!this.db) {
      this.cache.set(template.id, template);
      return template;
    }

    try {
      const existing = await this.db
        .model('promptTemplate')
        .findUnique({ where: { id: template.id } });
      const data = { ...template, updatedAt: new Date() } as unknown as Record<string, unknown>;

      if (existing) {
        const version = ((existing as unknown as PromptTemplate).version ?? 0) + 1;
        await this.db.model('promptTemplate').update({
          where: { id: template.id },
          data: { ...data, version },
        });
        template.version = version;
      } else {
        await this.db.model('promptTemplate').create({
          data: { ...data, version: 1, createdAt: new Date() },
        });
        template.version = 1;
      }
    } catch (err) {
      this.logger.warn(
        `Prompt template save to DB failed, using cache: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.cache.set(template.id, template);
    return template;
  }

  /** 删除提示词模板 */
  async deleteTemplate(id: string): Promise<boolean> {
    this.cache.delete(id);
    if (!this.db) return true;
    try {
      await this.db.model('promptTemplate').delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 按 key 查询当前激活的模板（多版本场景）。
   * 优先返回 version 最高的激活版本。
   *
   * @example
   * ```ts
   * // 单 key
   * const tpl = await mgr.findActiveByKey({ key: 'software.sections' });
   * // 多 key 候选（取第一个匹配）
   * const tpl = await mgr.findActiveByKey({ keys: ['sections', 'software.sections'] });
   * ```
   */
  async findActiveByKey(options: FindByKeyOptions): Promise<PromptTemplate | null> {
    const candidates = options.keys ?? (options.key ? [options.key] : []);
    if (candidates.length === 0) return null;
    const activeOnly = options.activeOnly !== false;

    if (!this.db) {
      // 内存 cache 模式
      const all = Array.from(this.cache.values());
      const matched = all.filter(
        (t) => candidates.includes(t.key ?? '') && (activeOnly ? t.isActive !== false : true),
      );
      if (matched.length === 0) return null;
      return matched.sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0];
    }

    try {
      const where: Record<string, unknown> = {
        key: candidates.length === 1 ? candidates[0] : { in: candidates },
      };
      if (activeOnly) where.isActive = true;
      const records = await this.db.model('promptTemplate').findMany({
        where,
        orderBy: { version: 'desc' },
      });
      const list = records as unknown as PromptTemplate[];
      return list[0] ?? null;
    } catch (err) {
      this.logger.warn(
        `findActiveByKey 数据库失败: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * 把 PromptTemplate 的 responseFormat 转换为 OpenAI Chat Completions API
   * 的 response_format 参数。
   *
   * - json_object → { type: 'json_object' }
   * - json_schema 带 schema → { type: 'json_schema', json_schema: ... }
   * - json_schema 缺 schema → 降级 json_object（warn）
   * - json_array / text / undefined → undefined（消费方自行处理）
   */
  getResponseFormat(template: PromptTemplate):
    | { type: 'json_object' }
    | {
        type: 'json_schema';
        json_schema: { name?: string; schema: Record<string, unknown>; strict?: boolean };
      }
    | undefined {
    switch (template.responseFormat) {
      case 'json_object':
        return { type: 'json_object' };
      case 'json_schema':
        if (template.jsonSchema) {
          return { type: 'json_schema', json_schema: template.jsonSchema };
        }
        this.logger.warn(
          `Template ${template.id} responseFormat=json_schema 但缺 jsonSchema，降级为 json_object`,
        );
        return { type: 'json_object' };
      case 'json_array':
      case 'text':
      case undefined:
        return undefined;
    }
  }

  /** 列出所有模板 */
  async listTemplates(tags?: string[]): Promise<PromptTemplate[]> {
    if (!this.db) return Array.from(this.cache.values());
    try {
      const where = tags?.length ? { tags: { hasSome: tags } } : {};
      return (await this.db
        .model('promptTemplate')
        .findMany({ where })) as unknown as PromptTemplate[];
    } catch {
      return Array.from(this.cache.values());
    }
  }

  /**
   * 渲染提示词模板 — 将 {{variable}} 替换为实际值
   */
  render(template: PromptTemplate, variables: Record<string, unknown>): string {
    let content = template.content;
    const allVars = { ...variables };

    // 填充默认值
    if (template.variables) {
      for (const v of template.variables) {
        if (allVars[v.name] === undefined && v.defaultValue !== undefined) {
          allVars[v.name] = v.defaultValue;
        }
      }
    }

    content = parseTemplateWithMapper(
      content,
      (expression) => {
        let value: unknown = allVars;
        for (const key of expression.trim().split('.')) {
          if (!value || typeof value !== 'object' || !Object.hasOwn(value, key))
            return `{{${expression}}}`;
          value = (value as Record<string, unknown>)[key];
        }
        return value === undefined || value === null ? `{{${expression}}}` : String(value);
      },
      { startSymbol: '{{', endSymbol: '}}' },
    );

    return content;
  }

  /** 验证变量是否满足模板要求 */
  validateVariables(
    template: PromptTemplate,
    variables: Record<string, unknown>,
  ): { valid: boolean; missing: string[] } {
    const missing: string[] = [];
    if (template.variables) {
      for (const v of template.variables) {
        if (v.required && variables[v.name] === undefined && v.defaultValue === undefined) {
          missing.push(v.name);
        }
      }
    }
    return { valid: missing.length === 0, missing };
  }

  clearCache(): void {
    this.cache.clear();
  }
}
