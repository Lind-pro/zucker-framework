import { Injectable } from '@nestjs/common';
import type { DatabaseAdapter, ModelOperations } from '@zucker-framework/core';
import type { MailHistoryFilters } from './mail-engagement.service';

export interface MailHistoryRecord extends Record<string, unknown> {
  id: string;
  userId: string | null;
  recipient: string;
  errorMessage: string | null;
}
@Injectable()
export class MailHistoryService {
  constructor(private readonly database: DatabaseAdapter, private readonly model = 'emailLogs') {}
  private get records(): ModelOperations<MailHistoryRecord> {
    return this.database.model(this.model) as ModelOperations<MailHistoryRecord>;
  }
  async list(filters: MailHistoryFilters & { page?: number; pageSize?: number } = {}) {
    const page = Math.max(1, Math.trunc(filters.page || 1));
    const pageSize = Math.min(200, Math.max(1, Math.trunc(filters.pageSize || 20)));
    const where: Record<string, unknown> = {};
    for (const field of ['template', 'userId', 'status'] as const)
      if (filters[field]) where[field] = filters[field];
    if (filters.recipient && filters.recipient.trim().length >= 3) {
      where.recipient = { contains: filters.recipient.trim(), mode: 'insensitive' };
    }
    const [data, total] = await Promise.all([
      this.records.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.records.count({ where }),
    ]);
    return { data, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
  }
  async sentUserIds(
    template: string,
    options: { since?: Date; userIds?: string[] } = {},
  ): Promise<string[]> {
    const rows = await this.records.findMany({
      where: {
        template,
        status: 'success',
        userId: options.userIds ? { in: options.userIds } : { not: null },
        ...(options.since ? { createdAt: { gte: options.since } } : {}),
      },
      select: { userId: true },
      distinct: ['userId'],
    });
    return rows.map((row) => row.userId).filter((id): id is string => !!id);
  }
  async cleanup(successCutoff: Date, failedCutoff: Date) {
    const [success, other] = await Promise.all([
      this.records.deleteMany({ where: { status: 'success', createdAt: { lt: successCutoff } } }),
      this.records.deleteMany({
        where: { status: { not: 'success' }, createdAt: { lt: failedCutoff } },
      }),
    ]);
    return { success: success.count, other: other.count };
  }
}
