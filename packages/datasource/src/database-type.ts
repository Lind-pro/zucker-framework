/**
 * 数据库类型枚举 — 对应 Java 端 DatabaseType
 *
 * 每种数据库类型携带驱动元信息和健康检查语句，
 * 并提供 fromUrl() 静态方法从连接字符串推断类型。
 */
export interface DatabaseTypeInfo {
  /** 类型标识 */
  readonly name: string;
  /** 健康检查 SQL */
  readonly testQuery: string;
  /** URL 中的协议关键字 */
  readonly urlKeyword: string;
}

const DATABASE_TYPES = {
  unknown: { name: 'unknown', testQuery: '', urlKeyword: '' },
  mysql: { name: 'mysql', testQuery: 'SELECT 1', urlKeyword: 'mysql' },
  mariadb: { name: 'mariadb', testQuery: 'SELECT 1', urlKeyword: 'mariadb' },
  postgresql: { name: 'postgresql', testQuery: 'SELECT 1', urlKeyword: 'postgresql' },
  sqlite: { name: 'sqlite', testQuery: 'SELECT 1', urlKeyword: 'sqlite' },
  mssql: { name: 'mssql', testQuery: 'SELECT 1', urlKeyword: 'sqlserver' },
  oracle: { name: 'oracle', testQuery: 'SELECT 1 FROM dual', urlKeyword: 'oracle' },
  h2: { name: 'h2', testQuery: 'SELECT 1', urlKeyword: 'h2' },
  mongodb: { name: 'mongodb', testQuery: '', urlKeyword: 'mongodb' },
} as const;

export type DatabaseTypeName = keyof typeof DATABASE_TYPES;

export class DatabaseType {
  private constructor(private readonly info: DatabaseTypeInfo) {}

  get name(): string {
    return this.info.name;
  }

  get testQuery(): string {
    return this.info.testQuery;
  }

  /* ---- 预定义实例 ---- */
  static readonly UNKNOWN = new DatabaseType(DATABASE_TYPES.unknown);
  static readonly MYSQL = new DatabaseType(DATABASE_TYPES.mysql);
  static readonly MARIADB = new DatabaseType(DATABASE_TYPES.mariadb);
  static readonly POSTGRESQL = new DatabaseType(DATABASE_TYPES.postgresql);
  static readonly SQLITE = new DatabaseType(DATABASE_TYPES.sqlite);
  static readonly MSSQL = new DatabaseType(DATABASE_TYPES.mssql);
  static readonly ORACLE = new DatabaseType(DATABASE_TYPES.oracle);
  static readonly H2 = new DatabaseType(DATABASE_TYPES.h2);
  static readonly MONGODB = new DatabaseType(DATABASE_TYPES.mongodb);

  /** 所有已知类型 */
  static values(): DatabaseType[] {
    return [
      DatabaseType.MYSQL,
      DatabaseType.MARIADB,
      DatabaseType.POSTGRESQL,
      DatabaseType.SQLITE,
      DatabaseType.MSSQL,
      DatabaseType.ORACLE,
      DatabaseType.H2,
      DatabaseType.MONGODB,
    ];
  }

  /**
   * 从连接 URL 推断数据库类型
   *
   * @example
   *   DatabaseType.fromUrl('postgresql://localhost:5432/db') // POSTGRESQL
   *   DatabaseType.fromUrl('mysql://localhost:3306/db')      // MYSQL
   */
  static fromUrl(url: string | undefined | null): DatabaseType {
    if (!url) return DatabaseType.UNKNOWN;
    const lower = url.toLowerCase();
    for (const t of DatabaseType.values()) {
      if (t.info.urlKeyword && lower.includes(t.info.urlKeyword)) {
        return t;
      }
    }
    return DatabaseType.UNKNOWN;
  }

  /**
   * 按名称查找数据库类型
   */
  static fromName(name: string | undefined | null): DatabaseType {
    if (!name) return DatabaseType.UNKNOWN;
    const lower = name.toLowerCase() as DatabaseTypeName;
    const info = DATABASE_TYPES[lower];
    if (info) {
      const found = DatabaseType.values().find((t) => t.name === lower);
      return found ?? DatabaseType.UNKNOWN;
    }
    return DatabaseType.UNKNOWN;
  }

  toString(): string {
    return this.info.name;
  }
}
