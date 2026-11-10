import {
  type DatabaseAdapter,
  type ModelFieldInfo,
  type ModelOperations,
  TransactionAwareDatabaseAdapter,
} from '@zucker-framework/core';

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

  /**
   * Field metadata from the generated client's runtime data model
   * (`client._runtimeDataModel.models[Model].fields`). Returns undefined when the client does
   * not expose it (custom clients, mocks), in which case the query policy falls back to
   * stripping relation objects from included fields.
   */
  getModelFields(name: string): readonly ModelFieldInfo[] | undefined {
    return prismaModelFields(this.prisma, name, this.aliases);
  }

  protected async doTransaction<R>(fn: (adapter: DatabaseAdapter) => Promise<R>): Promise<R> {
    return this.prisma.$transaction(async (tx) => {
      return fn(new PrismaTransactionAdapter(tx, this.aliases, this.prisma));
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
    private readonly root?: Record<string, unknown>,
  ) {}

  getModelFields(name: string): readonly ModelFieldInfo[] | undefined {
    return prismaModelFields(this.root ?? this.tx, name, this.aliases);
  }

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
  const key = resolveModelKey(client, name, aliases);
  return key === undefined ? undefined : client[key];
}

/** The client property (delegate name) that `name` resolves to. */
function resolveModelKey(
  client: Record<string, unknown>,
  name: string,
  aliases: Record<string, string>,
): string | undefined {
  if (client[name]) return name;

  // 显式别名
  const alias = aliases[name];
  if (alias && client[alias]) return alias;

  // PascalCase acronym 自动派生（如 aiModels → aIModel）
  for (const candidate of deriveAcronymCandidates(name)) {
    if (client[candidate]) return candidate;
  }

  return undefined;
}

const FIELD_KINDS = new Set<ModelFieldInfo['kind']>(['scalar', 'enum', 'object', 'unsupported']);

interface RuntimeDataModel {
  models?: Record<string, { fields?: Array<{ name?: unknown; kind?: unknown; isList?: unknown }> }>;
}

function prismaModelFields(
  client: Record<string, unknown>,
  name: string,
  aliases: Record<string, string>,
): readonly ModelFieldInfo[] | undefined {
  let dataModel: RuntimeDataModel | undefined;
  try {
    dataModel = (client as { _runtimeDataModel?: RuntimeDataModel })._runtimeDataModel;
  } catch {
    return undefined;
  }
  const models = dataModel?.models;
  if (!models || typeof models !== 'object') return undefined;
  const key = resolveModelKey(client, name, aliases) ?? name;
  // Delegates are the model name with a lower-case first letter (`aIModel` → `AIModel`).
  const modelName = Object.keys(models).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
  const fields = modelName ? models[modelName]?.fields : undefined;
  if (!Array.isArray(fields)) return undefined;
  const result: ModelFieldInfo[] = [];
  for (const field of fields) {
    if (typeof field?.name !== 'string' || !FIELD_KINDS.has(field.kind as ModelFieldInfo['kind'])) continue;
    result.push({ name: field.name, kind: field.kind as ModelFieldInfo['kind'], isList: field.isList === true });
  }
  return result;
}
