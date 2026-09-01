import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PromptManager, type PromptTemplate } from './prompt-manager';

function makeDb(records: PromptTemplate[] = []) {
  return {
    model: vi.fn().mockReturnValue({
      findFirst: vi.fn().mockResolvedValue(records[0] ?? null),
      findMany: vi.fn().mockResolvedValue(records),
      findUnique: vi.fn().mockImplementation(({ where }: any) =>
        Promise.resolve(records.find((r) => r.id === where.id) ?? null),
      ),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
      createMany: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    }),
    $transaction: vi.fn(),
  } as any;
}

describe('PromptManager', () => {
  describe('getResponseFormat（A5 反哺）', () => {
    let mgr: PromptManager;

    beforeEach(() => {
      mgr = new PromptManager(makeDb());
    });

    it('无 responseFormat → undefined', () => {
      const tpl: PromptTemplate = { id: 't1', content: 'hello' };
      expect(mgr.getResponseFormat(tpl)).toBeUndefined();
    });

    it('json_object → { type: "json_object" }', () => {
      const tpl: PromptTemplate = { id: 't1', content: 'x', responseFormat: 'json_object' };
      expect(mgr.getResponseFormat(tpl)).toEqual({ type: 'json_object' });
    });

    it('json_schema + 完整 schema → 完整对象', () => {
      const schema = {
        name: 'OrderRow',
        schema: { type: 'object', properties: { id: { type: 'string' } } },
        strict: true,
      };
      const tpl: PromptTemplate = {
        id: 't1',
        content: 'x',
        responseFormat: 'json_schema',
        jsonSchema: schema,
      };
      expect(mgr.getResponseFormat(tpl)).toEqual({
        type: 'json_schema',
        json_schema: schema,
      });
    });

    it('json_schema 缺 schema → 降级为 json_object', () => {
      const tpl: PromptTemplate = { id: 't1', content: 'x', responseFormat: 'json_schema' };
      expect(mgr.getResponseFormat(tpl)).toEqual({ type: 'json_object' });
    });

    it('json_array → undefined（OpenAI 不支持）', () => {
      const tpl: PromptTemplate = { id: 't1', content: 'x', responseFormat: 'json_array' };
      expect(mgr.getResponseFormat(tpl)).toBeUndefined();
    });

    it('text → undefined', () => {
      const tpl: PromptTemplate = { id: 't1', content: 'x', responseFormat: 'text' };
      expect(mgr.getResponseFormat(tpl)).toBeUndefined();
    });
  });

  describe('findActiveByKey（A5 反哺）', () => {
    const v1: PromptTemplate = { id: 't1', key: 'software.sections', content: 'v1', version: 1, isActive: true };
    const v2: PromptTemplate = { id: 't2', key: 'software.sections', content: 'v2', version: 2, isActive: true };
    const v3Inactive: PromptTemplate = {
      id: 't3', key: 'software.sections', content: 'v3', version: 3, isActive: false,
    };

    it('单 key 命中 + 取 version 最高激活版', async () => {
      const mgr = new PromptManager(makeDb([v2, v1]));  // findMany 返回顺序按 orderBy desc
      const tpl = await mgr.findActiveByKey({ key: 'software.sections' });
      expect(tpl?.version).toBe(2);
    });

    it('多 key 候选查询', async () => {
      const mgr = new PromptManager(makeDb([v1]));
      const tpl = await mgr.findActiveByKey({
        keys: ['sections', 'software.sections'],
      });
      expect(tpl?.id).toBe('t1');
    });

    it('activeOnly=false 时包含 inactive', async () => {
      const mgr = new PromptManager(makeDb([v3Inactive]));
      const tpl = await mgr.findActiveByKey({
        key: 'software.sections',
        activeOnly: false,
      });
      expect(tpl?.id).toBe('t3');
    });

    it('无任何 key 时返回 null', async () => {
      const mgr = new PromptManager(makeDb([v1]));
      const tpl = await mgr.findActiveByKey({});
      expect(tpl).toBeNull();
    });

    it('数据库失败时返回 null（不抛错）', async () => {
      const db = {
        model: () => ({
          findMany: vi.fn().mockRejectedValue(new Error('DB down')),
        }),
        $transaction: vi.fn(),
      } as any;
      const mgr = new PromptManager(db);
      const tpl = await mgr.findActiveByKey({ key: 'x' });
      expect(tpl).toBeNull();
    });

    it('无 db（仅内存 cache）模式：能从 cache 中匹配', async () => {
      const mgr = new PromptManager(undefined);
      await mgr.saveTemplate({ id: 't1', key: 'foo', content: 'v1', version: 1, isActive: true });
      await mgr.saveTemplate({ id: 't2', key: 'foo', content: 'v2', version: 2, isActive: true });
      await mgr.saveTemplate({ id: 't3', key: 'foo', content: 'v3', version: 3, isActive: false });

      const active = await mgr.findActiveByKey({ key: 'foo' });
      expect(active?.id).toBe('t2');  // 最高激活版

      const allIncludingInactive = await mgr.findActiveByKey({ key: 'foo', activeOnly: false });
      expect(allIncludingInactive?.id).toBe('t3');  // 所有里面 version 最高
    });
  });
});
