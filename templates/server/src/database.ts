import type { OnApplicationShutdown } from '@nestjs/common';
import type { DatabaseAdapter, ModelOperations } from '@zucker-framework/core';
import { PrismaAdapter } from '@zucker-framework/crud';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from './generated/prisma/client';

/**
 * Interactive transaction limits. Financial paths take per-account advisory locks and then run several
 * statements, so Prisma's 2 s wait / 5 s run defaults expire under ordinary contention.
 */
export const TRANSACTION_LIMITS = Object.freeze({ maxWait: 10_000, timeout: 30_000 });

/** Same transaction for typed model operations and fixed, parameterized application SQL. */
export class ApplicationTransaction implements DatabaseAdapter {
  private readonly adapter: PrismaAdapter;
  constructor(private readonly client: Prisma.TransactionClient) {
    // Only model() is delegated here; nested transaction work is flattened below.
    this.adapter = new PrismaAdapter(client as unknown as ConstructorParameters<typeof PrismaAdapter>[0]);
  }
  model(name: string): ModelOperations { return this.adapter.model(name); }
  $transaction<T>(work: (tx: DatabaseAdapter) => Promise<T>): Promise<T> { return work(this); }
  async query<TRow = Record<string, unknown>>(sql: string, values: readonly unknown[] = []): Promise<{ rows: TRow[] }> {
    return { rows: await this.client.$queryRawUnsafe<TRow[]>(sql, ...values) };
  }
}

/** One consumer-owned Prisma client; every transaction pins raw SQL to the URL's schema. */
export class ApplicationDatabase extends PrismaAdapter implements OnApplicationShutdown {
  private readonly client: PrismaClient;
  private readonly schema: string;
  constructor(connectionString: string) {
    const url = new URL(connectionString);
    const schema = url.searchParams.get('schema') ?? 'public';
    // Prisma's Date encoding and adapter-pg timestamp normalization require a UTC session.
    // Pin every pool connection, including direct model reads outside an interactive transaction.
    const startupOptions = url.searchParams.get('options')?.trim();
    url.searchParams.set('options', `${startupOptions ? `${startupOptions} ` : ''}-c timezone=UTC`);
    const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.href }, { schema }) });
    super(client as unknown as ConstructorParameters<typeof PrismaAdapter>[0]);
    this.client = client;
    this.schema = schema;
  }
  protected override doTransaction<T>(work: (tx: DatabaseAdapter) => Promise<T>): Promise<T> {
    return this.client.$transaction(async client => {
      // PrismaPg's schema maps generated queries; PostgreSQL raw SQL needs its own transaction-local path.
      await client.$queryRawUnsafe("SELECT set_config('search_path', quote_ident($1), true) AS path, set_config('TimeZone', 'UTC', true) AS timezone", this.schema);
      return work(new ApplicationTransaction(client));
    }, TRANSACTION_LIMITS);
  }
  transaction<T>(work: (tx: ApplicationTransaction) => Promise<T>): Promise<T> {
    return this.$transaction(tx => {
      if (!(tx instanceof ApplicationTransaction)) throw new Error('Application transaction is required');
      return work(tx);
    });
  }
  async disconnect(): Promise<void> { await this.client.$disconnect(); }
  /**
   * Nest closes the HTTP listener after `onModuleDestroy`/`beforeApplicationShutdown` and before
   * `onApplicationShutdown`; disconnecting here lets in-flight requests and the job host's drain
   * (stopped in `onModuleDestroy`) finish their final writes first.
   */
  async onApplicationShutdown(): Promise<void> { await this.disconnect(); }
}
