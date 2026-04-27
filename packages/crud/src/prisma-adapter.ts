import { type DatabaseAdapter, type ModelOperations, TransactionAwareDatabaseAdapter } from '@zucker/core';

/** Minimal interface for a Prisma-like client */
interface PrismaLikeClient extends Record<string, unknown> {
  $transaction<T>(fn: (tx: Record<string, unknown>) => Promise<T>): Promise<T>;
}

/**
 * 模型名映射表 — 解决代码中使用单数名 vs Prisma schema 中复数名的差异。
 * 当代码调用 db.model('dictionary') 时，PrismaAdapter 自动映射到 prisma.dictionaries。
 * 仅在 Prisma Client 中不存在原始名称时才尝试映射。
 */
const DEFAULT_MODEL_NAME_ALIASES: Record<string, string> = {
  dictionary: 'dictionaries',
  dictionaryItem: 'dictionaryItems',
};

/**
 * 自动派生 acronym 别名（处理 PascalCase 中连续大写字母的边界）。
 *
 * Prisma client 把 schema 中 `model AIModel` 序列化成 `prisma.aIModel`
 * （首字母小写，但保留连续大写）。代码里通常写 `aiModels`，差异：
 *
 * 1. 复数 → 单数（去尾 `s`）
 * 2. 全小写连续字母段 → 首字母小写但其余大写（`ai` → `aI`）
 *
 * 对 `aiModels` 自动派生候选 `aIModel` / `aIModels`。
 * 仅在原名 + 显式别名都 miss 时尝试，不破坏现有命中。
 */
function deriveAcronymCandidates(name: string): string[] {
  const candidates: string[] = [];

  // 提取前置全小写段：`aiModels` → 前缀 `ai`
  const m = name.match(/^([a-z]+)([A-Z].*)$/);
  if (!m) return candidates;
  const [, lowerPrefix, rest] = m;
  if (lowerPrefix.length < 2) return candidates;

  // 把前缀首字母保留小写，其余大写：`ai` → `aI`
  const acronymPrefix = lowerPrefix[0] + lowerPrefix.slice(1).toUpperCase();

  candidates.push(acronymPrefix + rest);
  // 单复数兼容：去尾 's'
  if (rest.endsWith('s')) {
    candidates.push(acronymPrefix + rest.slice(0, -1));
  }

  return candidates;
}

export interface PrismaAdapterOptions {
  /** 项目级别的额外模型名别名（业务侧覆盖 framework 默认） */
  modelAliases?: Record<string, string>;
}

export class PrismaAdapter extends TransactionAwareDatabaseAdapter {
  private readonly aliases: Record<string, string>;

  constructor(
    private readonly prisma: PrismaLikeClient,
    options: PrismaAdapterOptions = {},
  ) {
    super();
    this.aliases = { ...DEFAULT_MODEL_NAME_ALIASES, ...(options.modelAliases ?? {}) };
  }

  model(name: string): ModelOperations {
    const model = resolveModel(this.prisma, name, this.aliases);
    if (!model) {
      throw new Error(`Model "${name}" not found in Prisma client`);
    }
    return model as unknown as ModelOperations;
  }

  protected async doTransaction<R>(fn: (adapter: DatabaseAdapter) => Promise<R>): Promise<R> {
    return this.prisma.$transaction(async (tx) => {
      return fn(new PrismaTransactionAdapter(tx, this.aliases));
    });
  }
}

/**
 * 事务内的 PrismaAdapter — 不再包装 TransactionContext
 * 因为事务上下文已由外层 PrismaAdapter.$transaction 管理
 */
class PrismaTransactionAdapter implements DatabaseAdapter {
  constructor(
    private readonly tx: Record<string, unknown>,
    private readonly aliases: Record<string, string>,
  ) {}

  model(name: string): ModelOperations {
    const model = resolveModel(this.tx, name, this.aliases);
    if (!model) {
      throw new Error(`Model "${name}" not found in Prisma transaction client`);
    }
    return model as unknown as ModelOperations;
  }

  async $transaction<R>(fn: (adapter: DatabaseAdapter) => Promise<R>): Promise<R> {
    // 已在事务内，直接执行（嵌套事务扁平化）
    return fn(this);
  }
}

function resolveModel(
  client: Record<string, unknown>,
  name: string,
  aliases: Record<string, string>,
): unknown {
  let model = client[name];
  if (model) return model;

  // 显式别名
  const alias = aliases[name];
  if (alias) {
    model = client[alias];
    if (model) return model;
  }

  // PascalCase acronym 自动派生（如 aiModels → aIModel）
  for (const candidate of deriveAcronymCandidates(name)) {
    model = client[candidate];
    if (model) return model;
  }

  return undefined;
}
