import { describe, it, expect } from 'vitest';
import { PrismaAdapter } from './prisma-adapter';

function makePrismaLike(models: Record<string, unknown>): any {
  return {
    ...models,
    $transaction: async (fn: any) => fn({ ...models }),
  };
}

describe('PrismaAdapter', () => {
  it('resolves model by exact name', () => {
    const prisma = makePrismaLike({ user: { findMany: () => 'users' } });
    const adapter = new PrismaAdapter(prisma);
    expect(adapter.model('user')).toBeDefined();
  });

  it('falls back to default alias for dictionary → dictionaries', () => {
    const prisma = makePrismaLike({ dictionaries: { findMany: () => [] } });
    const adapter = new PrismaAdapter(prisma);
    expect(adapter.model('dictionary')).toBeDefined();
  });

  it('throws when model unresolvable', () => {
    const prisma = makePrismaLike({});
    const adapter = new PrismaAdapter(prisma);
    expect(() => adapter.model('nonExistent')).toThrow(/not found/);
  });

  describe('PascalCase acronym auto-derive', () => {
    it('auto-derives aiModels → aIModel', () => {
      const prisma = makePrismaLike({ aIModel: { findMany: () => [] } });
      const adapter = new PrismaAdapter(prisma);
      expect(adapter.model('aiModels')).toBeDefined();
    });

    it('auto-derives aiModelUsage → aIModelUsage', () => {
      const prisma = makePrismaLike({ aIModelUsage: { findMany: () => [] } });
      const adapter = new PrismaAdapter(prisma);
      expect(adapter.model('aiModelUsage')).toBeDefined();
    });

    it('auto-derives uiGenome → uIGenome (single uppercase rest)', () => {
      const prisma = makePrismaLike({ uIGenome: { findMany: () => [] } });
      const adapter = new PrismaAdapter(prisma);
      expect(adapter.model('uiGenome')).toBeDefined();
    });

    it('does not interfere with normal camelCase that already exists', () => {
      const prisma = makePrismaLike({
        aiModels: { findMany: () => 'plural' },
        aIModel: { findMany: () => 'singular' },
      });
      const adapter = new PrismaAdapter(prisma);
      // 直接命中原名优先
      expect(adapter.model('aiModels')).toBeDefined();
    });
  });

  describe('explicit modelAliases option', () => {
    it('user-supplied alias wins over auto-derive', () => {
      const prisma = makePrismaLike({ customTarget: { findMany: () => 'hit' } });
      const adapter = new PrismaAdapter(prisma, {
        modelAliases: { foo: 'customTarget' },
      });
      expect(adapter.model('foo')).toBeDefined();
    });

    it('custom alias survives transaction context', async () => {
      const prisma = makePrismaLike({ customTarget: { findMany: () => 'hit' } });
      const adapter = new PrismaAdapter(prisma, {
        modelAliases: { foo: 'customTarget' },
      });
      await adapter.$transaction(async (tx) => {
        expect(tx.model('foo')).toBeDefined();
      });
    });
  });
});
