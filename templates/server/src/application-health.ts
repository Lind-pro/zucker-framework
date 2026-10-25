import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { HealthCheckService, HealthStatus } from '@zucker-framework/monitoring';
import { ApplicationDatabase } from './database';

/** The monitoring controller owns the sole health route; this host supplies its actual dependency check. */
@Injectable()
export class ApplicationHealth implements OnModuleInit, OnModuleDestroy {
  private registered = false;
  constructor(@Inject(DATABASE_ADAPTER) private readonly database: ApplicationDatabase, private readonly health: HealthCheckService) {}
  onModuleInit(): void {
    if (this.registered) return;
    this.registered = true;
    this.health.registerIndicator({ name: 'database', check: async () => {
      // The transaction pins the consumer schema, so a sibling schema cannot accidentally satisfy readiness.
      const result = await this.database.transaction(tx => tx.query<{ ready: boolean }>(`SELECT
        to_regclass('users') IS NOT NULL AND to_regclass('account_sessions') IS NOT NULL
        AND to_regclass('account_avatar_changes') IS NOT NULL
        AND to_regclass('billing_orders') IS NOT NULL AND to_regclass('billing_subscriptions') IS NOT NULL
        AND to_regclass('async_jobs') IS NOT NULL AND to_regclass('notification_deliveries') IS NOT NULL
        AND to_regclass('file_assets') IS NOT NULL AND to_regclass('site_content_entries') IS NOT NULL
        AND to_regclass('quota_reservations') IS NOT NULL AND to_regclass('credit_lots') IS NOT NULL
        AND to_regclass('credit_holds') IS NOT NULL AND to_regclass('credit_hold_allocations') IS NOT NULL
        AND to_regclass('billing_refund_payments') IS NOT NULL AND to_regclass('billing_refund_requests') IS NOT NULL
        AND to_regclass('billing_refund_receipts') IS NOT NULL AND to_regclass('billing_refund_events') IS NOT NULL AS ready`));
      const ready = result.rows[0]?.ready === true;
      return { name: 'database', status: ready ? HealthStatus.UP : HealthStatus.DOWN,
        details: { connected: true, schemaReady: ready }, timestamp: new Date() };
    } });
  }
  onModuleDestroy(): void {
    if (!this.registered) return;
    this.registered = false; this.health.unregisterIndicator('database');
  }
}
