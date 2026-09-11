import { Injectable } from '@nestjs/common';
import type { DatabaseAdapter, ModelOperations } from '@zucker-framework/core';

export interface OperationalMetricsOptions {
  database: DatabaseAdapter;
  query: (sql: string, values: unknown[]) => Promise<Record<string, unknown>[]>;
  accessModel?: string;
  operationModel?: string;
  loginModel?: string;
  unknownCountryLabel?: string;
  accessTable: string;
  loginTable: string;
  sensitiveModules: string[];
  highTrafficThreshold?: number;
  failedLoginThreshold?: number;
  bruteForceThreshold?: number;
}
interface MetricGroup {
  loginMethod?: string;
  ip?: string | null;
  country?: string | null;
  module: string;
  action: string;
  userId: string | null;
  _count: { id: number };
}
/** Database-backed traffic/security metrics using the existing audit schema and SQL connection. */
@Injectable()
export class OperationalMetricsService {
  private readonly access: ModelOperations;
  private readonly operations: ModelOperations;
  private readonly accessTable: string;
  private readonly loginTable: string;
  constructor(private readonly options: OperationalMetricsOptions) {
    const identifier = (name: string) => {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error('Invalid metrics table');
      return `"${name}"`;
    };
    this.accessTable = identifier(options.accessTable);
    this.loginTable = identifier(options.loginTable);
    this.access = options.database.model(options.accessModel ?? 'accessLogs');
    this.operations = options.database.model(options.operationModel ?? 'operationLogs');
  }
  private getDateThreshold(hours: number) {
    return new Date(Date.now() - hours * 3_600_000);
  }
  private query<T>(sql: string, values: unknown[]): Promise<T> {
    return this.options.query(sql, values) as Promise<T>;
  }
  private async groupBy(
    model: ModelOperations,
    args: Record<string, unknown>,
  ): Promise<MetricGroup[]> {
    if (!model.groupBy) throw new Error('Operational metrics require database groupBy support');
    return (await model.groupBy(args)) as unknown as MetricGroup[];
  }
  private get logins() {
    return this.options.database.model(this.options.loginModel ?? 'userLoginHistory');
  }
  async getLoginUserIds(hours: number): Promise<string[]> {
    const users = await this.groupBy(this.logins, {
      by: ['userId'],
      where: { createdAt: { gte: this.getDateThreshold(hours) }, success: true },
    });
    return users.map((user) => user.userId).filter((id): id is string => id !== null);
  }
  async getLoginStats(hours: number) {
    const since = this.getDateThreshold(hours);
    const [totalLogins, users, methods, failed] = await Promise.all([
      this.logins.count({ where: { createdAt: { gte: since }, success: true } }),
      this.groupBy(this.logins, {
        by: ['userId'],
        where: { createdAt: { gte: since }, success: true },
      }),
      this.groupBy(this.logins, {
        by: ['loginMethod'],
        where: { createdAt: { gte: since }, success: true },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
      }),
      this.groupBy(this.logins, {
        by: ['ip'],
        where: { createdAt: { gte: since }, success: false },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 10,
      }),
    ]);
    return {
      login: {
        totalLogins,
        uniqueUsers: users.length,
        byMethod: methods.map((row) => ({ method: row.loginMethod, count: row._count.id })),
      },
      failedLoginIPs: failed.map((row) => ({ ip: row.ip, count: row._count.id })),
    };
  }
  async getGeographicDistribution(hours: number) {
    const rows = await this.groupBy(this.logins, {
      by: ['country'],
      where: {
        createdAt: { gte: this.getDateThreshold(hours) },
        success: true,
        country: { not: null },
      },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 20,
    });
    return {
      byCountry: rows.map((row) => ({
        country: row.country || this.options.unknownCountryLabel || 'Unknown',
        count: row._count.id,
      })),
    };
  }

  async getActiveUserCounts(hours: number) {
    return this.groupBy(this.operations, {
      by: ['userId'],
      where: { createdAt: { gte: this.getDateThreshold(hours) }, userId: { not: null } },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 20,
    });
  }
  async getOperationHealth(hours = 1) {
    const where = { createdAt: { gte: this.getDateThreshold(hours) }, status: 'FAILED' };
    const [failedOpsLastHour, recentErrors] = await Promise.all([
      this.operations.count({ where }),
      this.operations.findMany({
        where,
        select: { id: true, module: true, action: true, errorMessage: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);
    return { failedOpsLastHour, recentErrors };
  }
  async getSlowRequests(hours: number, threshold: number) {
    const since = this.getDateThreshold(hours);

    const slowRequests = await this.access.findMany({
      where: {
        requestTime: { gte: since },
        responseTime: { gte: threshold },
      },
      select: {
        id: true,
        action: true,
        describe: true,
        module: true,
        requestUrl: true,
        method: true,
        responseTime: true,
        username: true,
        ip: true,
        requestTime: true,
      },
      orderBy: { responseTime: 'desc' },
      take: 20,
    });

    return { slowRequests };
  }

  async getErrorRateByModule(hours: number) {
    const since = this.getDateThreshold(hours);

    const [errors, totalByModule] = await Promise.all([
      this.groupBy(this.operations, {
        by: ['module', 'action'],
        where: { createdAt: { gte: since }, status: 'FAILED' },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 10,
      }),
      this.groupBy(this.operations, {
        by: ['module'],
        where: { createdAt: { gte: since } },
        _count: { id: true },
      }),
    ]);

    const totalMap = new Map(totalByModule.map((t) => [t.module, t._count.id]));

    return {
      errorsByModule: errors.map((e) => ({
        module: e.module,
        action: e.action,
        count: e._count.id,
        totalInModule: totalMap.get(e.module) || 0,
      })),
    };
  }

  async getResponseTimePercentiles(hours: number) {
    const since = this.getDateThreshold(hours);

    const result = await this.query<
      Array<{
        p50: number;
        p95: number;
        p99: number;
        avg: number;
        total: bigint;
      }>
    >(
      `
      SELECT
        COALESCE(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY "responseTime"), 0)::int as p50,
        COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY "responseTime"), 0)::int as p95,
        COALESCE(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY "responseTime"), 0)::int as p99,
        COALESCE(AVG("responseTime"), 0)::int as avg,
        COUNT(*)::bigint as total
      FROM ${this.accessTable}
      WHERE "requestTime" >= $1
        AND "responseTime" IS NOT NULL
        AND "responseTime" > 0
    `,
      [since],
    );

    const row = result[0];
    return {
      p50: Number(row?.p50 || 0),
      p95: Number(row?.p95 || 0),
      p99: Number(row?.p99 || 0),
      avg: Number(row?.avg || 0),
      totalRequests: Number(row?.total || 0),
    };
  }

  async getHourlyTraffic(hours: number) {
    const since = this.getDateThreshold(hours);

    const result = await this.query<Array<{ hour: number; count: bigint }>>(
      `
      SELECT EXTRACT(HOUR FROM "requestTime")::int as hour, COUNT(*)::bigint as count
      FROM ${this.accessTable}
      WHERE "requestTime" >= $1
      GROUP BY hour
      ORDER BY hour
    `,
      [since],
    );

    // Fill all 24 hours (some may have 0)
    const hourMap = new Map(result.map((r) => [Number(r.hour), Number(r.count)]));
    const hourlyTraffic = Array.from({ length: 24 }, (_, i) => ({
      hour: i,
      count: hourMap.get(i) || 0,
    }));

    return { hourlyTraffic };
  }

  async getSecurityStats(hours: number) {
    const since = this.getDateThreshold(hours);

    const [
      suspiciousIPs,
      failedAuthByIP,
      sensitiveModuleFailures,
      bruteForceIPs,
      rejectedByStatus,
      scannerIPs,
    ] = await Promise.all([
      // 1. IP 异常高频访问（超过 100 次/时段 的 IP）
      this.query<Array<{ ip: string; count: bigint; error_count: bigint }>>(
        `
        SELECT
          ip,
          COUNT(*)::bigint as count,
          COUNT(CASE WHEN exception IS NOT NULL THEN 1 END)::bigint as error_count
        FROM ${this.accessTable}
        WHERE "requestTime" >= $1
          AND ip IS NOT NULL
          AND ip != ''
        GROUP BY ip
        HAVING COUNT(*) > $2
        ORDER BY count DESC
        LIMIT 20
      `,
        [since, this.options.highTrafficThreshold ?? 100],
      ),

      // 2. 登录失败按 IP+用户 聚合（发现撞库模式：同 IP 尝试多个用户）
      this.query<
        Array<{
          ip: string;
          attempted_users: bigint;
          fail_count: bigint;
          last_attempt: Date;
        }>
      >(
        `
        SELECT
          ip,
          COUNT(DISTINCT "userId")::bigint as attempted_users,
          COUNT(*)::bigint as fail_count,
          MAX("createdAt") as last_attempt
        FROM ${this.loginTable}
        WHERE "createdAt" >= $1
          AND success = false
        GROUP BY ip
        HAVING COUNT(*) >= $2
        ORDER BY fail_count DESC
        LIMIT 20
      `,
        [since, this.options.failedLoginThreshold ?? 5],
      ),

      // 3. 敏感模块的失败操作（payment, api-key, oauth）
      this.operations.findMany({
        where: {
          createdAt: { gte: since },
          status: 'FAILED',
          module: { in: this.options.sensitiveModules },
        },
        select: {
          id: true,
          module: true,
          action: true,
          userId: true,
          ipAddress: true,
          errorMessage: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),

      // 4. 短时间暴力破解检测（同 IP 1小时窗口内失败 >= 10 次）
      this.query<Array<{ ip: string; fail_count: bigint; window_start: Date }>>(
        `
        SELECT
          ip,
          COUNT(*)::bigint as fail_count,
          MIN("createdAt") as window_start
        FROM ${this.loginTable}
        WHERE "createdAt" >= $1
          AND success = false
        GROUP BY ip, date_trunc('hour', "createdAt")
        HAVING COUNT(*) >= $2
        ORDER BY fail_count DESC
        LIMIT 10
      `,
        [since, this.options.bruteForceThreshold ?? 10],
      ),

      // 5. 被拒请求按状态码分布（中间件记录的 4xx/5xx）
      this.groupBy(this.access, {
        by: ['action'],
        where: {
          requestTime: { gte: since },
          module: 'http',
        },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
      }),

      // 6. 404 扫描 IP Top 20
      this.query<Array<{ ip: string; count: bigint }>>(
        `
        SELECT ip, COUNT(*)::bigint as count
        FROM ${this.accessTable}
        WHERE "requestTime" >= $1
          AND module = 'http'
          AND action = 'http:404'
          AND ip IS NOT NULL
          AND ip != ''
        GROUP BY ip
        ORDER BY count DESC
        LIMIT 20
      `,
        [since],
      ),
    ]);

    return {
      suspiciousIPs: suspiciousIPs.map((r) => ({
        ip: r.ip,
        requestCount: Number(r.count),
        errorCount: Number(r.error_count),
        errorRate:
          Number(r.count) > 0 ? Math.round((Number(r.error_count) / Number(r.count)) * 100) : 0,
      })),
      failedAuthByIP: failedAuthByIP.map((r) => ({
        ip: r.ip,
        attemptedUsers: Number(r.attempted_users),
        failCount: Number(r.fail_count),
        lastAttempt: r.last_attempt,
      })),
      sensitiveModuleFailures,
      bruteForceAlerts: bruteForceIPs.map((r) => ({
        ip: r.ip,
        failCount: Number(r.fail_count),
        windowStart: r.window_start,
      })),
      rejectedByStatus: rejectedByStatus.map((r) => ({
        status: r.action,
        count: r._count.id,
      })),
      scannerIPs: scannerIPs.map((r) => ({
        ip: r.ip,
        count: Number(r.count),
      })),
    };
  }
}
