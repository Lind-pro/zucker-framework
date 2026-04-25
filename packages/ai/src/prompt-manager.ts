import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import type { DatabaseAdapter } from '@zucker/core';
import { DATABASE_ADAPTER } from '@zucker/crud';

/**
 * 提示词模板定义。
 * 对标 jetlinks PromptTemplate — 管理 AI 提示词模板。
 */
export interface PromptTemplate {
  id: string;
  name: string;
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
  /** 使用的模型 */
  model?: string;
  /** 使用的 provider */
  provider?: string;
  /** 温度参数 */
  temperature?: number;
  /** 最大输出 token */
  maxTokens?: number;
  createdAt?: Date;
  updatedAt?: Date;
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

  constructor(
    @Inject(DATABASE_ADAPTER) @Optional() private readonly db?: DatabaseAdapter,
  ) {}

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
      const existing = await this.db.model('promptTemplate').findUnique({ where: { id: template.id } });
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
      this.logger.warn(`Prompt template save to DB failed, using cache: ${err instanceof Error ? err.message : String(err)}`);
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

  /** 列出所有模板 */
  async listTemplates(tags?: string[]): Promise<PromptTemplate[]> {
    if (!this.db) return Array.from(this.cache.values());
    try {
      const where = tags?.length ? { tags: { hasSome: tags } } : {};
      return await this.db.model('promptTemplate').findMany({ where }) as unknown as PromptTemplate[];
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

    // 替换 {{variable}}
    content = content.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      const val = allVars[key];
      return val !== undefined ? String(val) : `{{${key}}}`;
    });

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
