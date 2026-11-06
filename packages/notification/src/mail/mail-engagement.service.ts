import { Injectable, ServiceUnavailableException } from '@nestjs/common';

export interface ResendEvent {
  type?: string;
  created_at?: string;
  data?: { to?: string | string[]; bounce?: { type?: string }; email_id?: string };
}
export interface MailEngagementOptions {
  /** Parameterized SQL executor using the application's existing PostgreSQL connection. */
  query: (sql: string, values: unknown[]) => Promise<Record<string, unknown>[]>;
  table: string;
  provider?: string;
  trackingMarker?: string;
  trackingConfigured: () => boolean;
  windowDays?: number;
  unmatchedRetryMs?: number;
}
export interface MailHistoryFilters {
  template?: string;
  recipient?: string;
  userId?: string;
  status?: string;
}
const FIELDS: Record<string, string> = {
  'email.delivered': 'Delivered',
  'email.opened': 'Opened',
  'email.clicked': 'Clicked',
  'email.bounced': 'Bounced',
  'email.complained': 'Complained',
};

@Injectable()
export class MailEngagementService {
  private readonly table: string;
  constructor(private readonly options: MailEngagementOptions) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(options.table))
      throw new Error('Invalid mail history table');
    this.table = `"${options.table}"`;
  }
  async record(event: ResendEvent): Promise<void> {
    const field = FIELDS[event.type ?? ''];
    const messageId = event.data?.email_id;
    const occurredAt = new Date(event.created_at ?? '');
    if (
      !field ||
      typeof messageId !== 'string' ||
      !messageId ||
      !Number.isFinite(occurredAt.getTime())
    )
      return;
    // Merge against the locked row, preserving concurrent event types. Min/max
    // makes duplicate and out-of-order callbacks idempotent; no IP/UA/URLs persist.
    const changed = await this.options.query(
      `
      UPDATE ${this.table}
      SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{engagement}',
        COALESCE(metadata->'engagement', '{}'::jsonb) || jsonb_build_object(
          $1::text, LEAST(metadata->'engagement'->>$1, $3::text),
          $2::text, GREATEST(metadata->'engagement'->>$2, $3::text)
        ))
      WHERE provider = $4 AND "messageId" = $5 RETURNING id
    `,
      [
        `first${field}At`,
        `last${field}At`,
        occurredAt.toISOString(),
        this.options.provider ?? 'Resend',
        messageId,
      ],
    );
    if (
      !changed.length &&
      Date.now() - occurredAt.getTime() < (this.options.unmatchedRetryMs ?? 600_000)
    ) {
      throw new ServiceUnavailableException('Mail history is not ready; retry the callback');
    }
  }
  /** Delivery and engagement over the send window, across all matching templates. */
  async stats(filters: MailHistoryFilters = {}) {
    const { rows, from, enabled } = await this.cohort(filters, false);
    return { ...this.summarize(rows[0], enabled), trackingConfigured: enabled, from: from.toISOString() };
  }

  /** The same figures per template, most-sent first, for comparing notifications. */
  async byTemplate(filters: Omit<MailHistoryFilters, 'template'> = {}) {
    const { rows, from, enabled } = await this.cohort(filters, true);
    return {
      trackingConfigured: enabled,
      from: from.toISOString(),
      templates: rows.map((row) => ({ template: (row.template as string | null) ?? null, ...this.summarize(row, enabled) })),
    };
  }

  private async cohort(filters: MailHistoryFilters, perTemplate: boolean) {
    const enabled = this.options.trackingConfigured();
    const from = new Date(Date.now() - (this.options.windowDays ?? 30) * 86_400_000);
    const values: unknown[] = [
      this.options.provider ?? 'Resend',
      from,
      this.options.trackingMarker ?? 'resend-v1',
    ];
    const conditions = [
      'provider = $1',
      '"createdAt" >= $2',
      '"messageId" IS NOT NULL',
      "status = 'success'",
    ];
    for (const field of ['template', 'userId'] as const) {
      if (filters[field]) {
        values.push(filters[field]);
        conditions.push(`"${field}" = $${values.length}`);
      }
    }
    if (filters.status && filters.status !== 'success') conditions.push('FALSE');
    if (filters.recipient && filters.recipient.trim().length >= 3) {
      values.push(filters.recipient.trim());
      conditions.push(`strpos(lower(recipient), lower($${values.length})) > 0`);
    }
    // Opens/clicks share the delivered-message cohort, so rates cannot exceed 100%.
    const group = perTemplate ? 'template' : 'NULL::text';
    const rows = await this.options.query(
      `
      WITH messages AS (
        SELECT "messageId", min(template) AS template,
          bool_or(metadata->'engagement'->>'firstDeliveredAt' IS NOT NULL) AS delivered,
          bool_or(metadata->'engagement'->>'firstOpenedAt' IS NOT NULL) AS opened,
          bool_or(metadata->'engagement'->>'firstClickedAt' IS NOT NULL) AS clicked,
          bool_or(metadata->'engagement'->>'firstBouncedAt' IS NOT NULL) AS bounced,
          bool_or(metadata->'engagement'->>'firstComplainedAt' IS NOT NULL) AS complained,
          bool_or(metadata->>'engagementTracking' = $3) AS tracked
        FROM ${this.table} WHERE ${conditions.join(' AND ')} GROUP BY "messageId"
      )
      SELECT ${group} AS template, count(*)::int AS accepted,
        count(*) FILTER (WHERE delivered)::int AS delivered,
        count(*) FILTER (WHERE bounced)::int AS bounced,
        count(*) FILTER (WHERE complained)::int AS complained,
        count(*) FILTER (WHERE delivered AND opened)::int AS opened,
        count(*) FILTER (WHERE delivered AND clicked)::int AS clicked,
        count(*) FILTER (WHERE tracked AND delivered)::int AS "trackedDelivered",
        count(*) FILTER (WHERE tracked AND delivered AND opened)::int AS "trackedOpened",
        count(*) FILTER (WHERE tracked AND delivered AND clicked)::int AS "trackedClicked"
      FROM messages ${perTemplate ? 'GROUP BY template ORDER BY accepted DESC, template' : ''}
    `,
      values,
    );
    return { rows, from, enabled };
  }

  private summarize(row: Record<string, unknown> | undefined, enabled: boolean) {
    const count = (key: string) => Number(row?.[key] ?? 0);
    const counts = {
      accepted: count('accepted'),
      delivered: count('delivered'),
      bounced: count('bounced'),
      complained: count('complained'),
      opened: count('opened'),
      clicked: count('clicked'),
      trackedDelivered: count('trackedDelivered'),
      trackedOpened: count('trackedOpened'),
      trackedClicked: count('trackedClicked'),
    };
    return {
      ...counts,
      openRate: enabled && counts.trackedDelivered ? counts.trackedOpened / counts.trackedDelivered : null,
      clickRate: enabled && counts.trackedDelivered ? counts.trackedClicked / counts.trackedDelivered : null,
      bounceRate: counts.accepted ? counts.bounced / counts.accepted : null,
    };
  }
}
