import { BadRequestException, ConflictException, ForbiddenException, HttpException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { ApplicationDatabase, type ApplicationTransaction } from '../database';
import { PolicyService } from '@zucker-framework/back-office/settings';
import { FEEDBACK_POLICY } from './feedback.policy';
import { FEEDBACK_NOTIFIER, type FeedbackNotifier } from './feedback.tokens';
import {
  FEEDBACK_OPEN_STATUSES, FEEDBACK_STATUSES, FEEDBACK_TYPES, localeFromHeader, pageNumber, parseRequestKey, parseSubmission, parseUpdate,
  sanitizeUserAgent, type FeedbackStatus, type FeedbackType,
} from './feedback.validation';

interface FeedbackRow {
  id: string; ownerId: string; requestKey: string; type: FeedbackType; message: string; pagePath: string | null; locale: string | null;
  userAgent: string | null; status: FeedbackStatus; reply: string | null; staffNote: string | null; handledBy: string | null;
  repliedAt: Date | null; revision: number; createdAt: Date; updatedAt: Date;
}

/** What the owner sees. `staffNote`, `handledBy`, the request key and diagnostics are never included. */
export interface FeedbackOwnerView {
  id: string; type: FeedbackType; message: string; status: FeedbackStatus; reply: string | null; repliedAt: Date | null; createdAt: Date;
}
/** Back-office projection (everything except the idempotency key). */
export type FeedbackStaffView = Omit<FeedbackRow, 'requestKey'>;

const OWNER_COLUMNS = 'id, type, message, status, reply, "repliedAt", "createdAt"';
const STAFF_COLUMNS = `id, "ownerId", type, message, "pagePath", locale, "userAgent", status, reply, "staffNote", "handledBy", "repliedAt",
  revision, "createdAt", "updatedAt"`;
/** Literal list from a fixed constant (never user input). */
const OPEN_SQL = FEEDBACK_OPEN_STATUSES.map(status => `'${status}'`).join(',');
const ownerView = (row: FeedbackRow): FeedbackOwnerView =>
  ({ id: row.id, type: row.type, message: row.message, status: row.status, reply: row.reply, repliedAt: row.repliedAt, createdAt: row.createdAt });
const staffView = ({ requestKey: _key, ...row }: FeedbackRow): FeedbackStaffView => row;

export interface SubmitContext { userAgent?: unknown; acceptLanguage?: unknown }

/**
 * Feedback owned by signed-in users with a staff reply. Users create and read only their own rows;
 * staff list, read and update every row with an `expectedRevision` compare-and-swap and an
 * `operationLogs` row written in the same transaction (field names only).
 */
@Injectable()
export class FeedbackService {
  constructor(@Inject(DATABASE_ADAPTER) private readonly database: ApplicationDatabase, private readonly policies: PolicyService,
    @Optional() @Inject(FEEDBACK_NOTIFIER) private readonly notifier?: FeedbackNotifier) {}

  /**
   * Creates one row per `(owner, Idempotency-Key)`. A replay with the same content returns the stored
   * row; a replay with different content is 409. The per-owner advisory lock serialises the replay
   * check, the open-item count and the insert, so concurrent requests cannot exceed the policy limit.
   */
  async submit(ownerId: string, requestKey: unknown, body: unknown, context: SubmitContext = {}): Promise<FeedbackOwnerView> {
    const key = parseRequestKey(requestKey), input = parseSubmission(body);
    const policy = await this.policies.get(FEEDBACK_POLICY);
    const locale = input.locale ?? localeFromHeader(context.acceptLanguage), userAgent = sanitizeUserAgent(context.userAgent);
    return this.database.transaction(async tx => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':feedback-owner:' || $1, 0))::text AS locked", [ownerId]);
      const existing = (await tx.query<FeedbackRow>(`SELECT * FROM "feedback" WHERE "ownerId"=$1 AND "requestKey"=$2`, [ownerId, key])).rows[0];
      if (existing) {
        if (existing.type !== input.type || existing.message !== input.message || existing.pagePath !== input.pagePath)
          throw new HttpException({ code: 'FEEDBACK_IDEMPOTENCY_CONFLICT', message: 'Idempotency-Key was reused with a different request' }, 409);
        return ownerView(existing);
      }
      if (!policy.enabled) throw new ForbiddenException({ code: 'FEEDBACK_DISABLED', message: 'Feedback is not accepted right now' });
      const open = (await tx.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM "feedback" WHERE "ownerId"=$1 AND status IN (${OPEN_SQL})`,
        [ownerId])).rows[0]?.count ?? 0;
      if (open >= policy.maxOpenPerUser)
        throw new HttpException({ code: 'FEEDBACK_TOO_MANY_OPEN', message: 'Too many open feedback items; wait for a reply first' }, 409);
      const row = (await tx.query<FeedbackRow>(`INSERT INTO "feedback" (id, "ownerId", "requestKey", type, message, "pagePath", locale, "userAgent")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [randomUUID(), ownerId, key, input.type, input.message, input.pagePath, locale, userAgent])).rows[0];
      if (!row) throw new Error('Feedback insert returned no row');
      return ownerView(row);
    });
  }

  /** The caller's own feedback, newest first: `{ data, total }`. */
  async mine(ownerId: string, query: Record<string, unknown>): Promise<{ data: FeedbackOwnerView[]; total: number }> {
    if (Object.keys(query).some(key => key !== 'page' && key !== 'pageSize')) throw new BadRequestException({ code: 'FEEDBACK_INVALID', message: 'Unsupported query' });
    const page = pageNumber(query.page, 1, 100_000, 'page'), pageSize = pageNumber(query.pageSize, 20, 50, 'pageSize');
    return this.database.transaction(async tx => {
      const rows = await tx.query<FeedbackRow>(`SELECT ${OWNER_COLUMNS} FROM "feedback" WHERE "ownerId"=$1 ORDER BY "createdAt" DESC, id DESC LIMIT $2 OFFSET $3`,
        [ownerId, pageSize, (page - 1) * pageSize]);
      const total = await tx.query<{ total: number }>('SELECT COUNT(*)::int AS total FROM "feedback" WHERE "ownerId"=$1', [ownerId]);
      return { data: rows.rows.map(ownerView), total: total.rows[0]?.total ?? 0 };
    });
  }

  /** Back-office list with equality filters: `{ data, total, page, pageSize }` (same shape as `/management/ai-tasks`). */
  async list(query: Record<string, unknown>): Promise<{ data: FeedbackStaffView[]; total: number; page: number; pageSize: number }> {
    if (Object.keys(query).some(key => !['page', 'pageSize', 'status', 'type', 'ownerId'].includes(key)))
      throw new BadRequestException('Only configured equality filters are supported');
    const page = pageNumber(query.page, 1, 100_000, 'page'), pageSize = pageNumber(query.pageSize, 20, 100, 'pageSize');
    const filter = (key: string, values?: readonly string[]) => {
      const value = query[key];
      if (value === undefined || value === '') return null;
      if (typeof value !== 'string' || value.length > 191 || (values && !values.includes(value))) throw new BadRequestException(`Invalid ${key} filter`);
      return value;
    };
    const params = [filter('status', FEEDBACK_STATUSES), filter('type', FEEDBACK_TYPES), filter('ownerId')];
    const where = 'WHERE ($1::text IS NULL OR status=$1) AND ($2::text IS NULL OR type=$2) AND ($3::text IS NULL OR "ownerId"=$3)';
    return this.database.transaction(async tx => {
      const rows = await tx.query<FeedbackRow>(`SELECT ${STAFF_COLUMNS} FROM "feedback" ${where} ORDER BY "createdAt" DESC, id DESC LIMIT $4 OFFSET $5`,
        [...params, pageSize, (page - 1) * pageSize]);
      const total = await tx.query<{ total: number }>(`SELECT COUNT(*)::int AS total FROM "feedback" ${where}`, params);
      return { data: rows.rows as FeedbackStaffView[], total: total.rows[0]?.total ?? 0, page, pageSize };
    });
  }

  /** One row for the back office, or null (same convention as the other management read-only records). */
  async get(id: string): Promise<FeedbackStaffView | null> {
    if (typeof id !== 'string' || id.length > 191) return null;
    const row = (await this.database.transaction(tx => tx.query<FeedbackRow>(`SELECT ${STAFF_COLUMNS} FROM "feedback" WHERE id=$1`, [id]))).rows[0];
    return row ? (row as FeedbackStaffView) : null;
  }

  /**
   * Staff update. 404 unknown id, 409 stale `expectedRevision`. A no-op returns the row unchanged
   * (no revision bump, no audit row). A new non-empty reply sets `repliedAt` and, when the port is
   * bound, notifies the owner inside the same transaction.
   */
  async update(actorId: string, id: string, body: unknown): Promise<FeedbackStaffView> {
    if (!actorId) throw new BadRequestException('Authenticated operator is required');
    const update = parseUpdate(body);
    if (typeof id !== 'string' || id.length > 191) throw new NotFoundException();
    return this.database.transaction(async tx => {
      const current = (await tx.query<FeedbackRow>('SELECT * FROM "feedback" WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!current) throw new NotFoundException({ code: 'FEEDBACK_NOT_FOUND', message: 'Feedback not found' });
      if (current.revision !== update.expectedRevision)
        throw new ConflictException({ code: 'FEEDBACK_REVISION_CONFLICT', message: 'Feedback changed; reload before saving', revision: current.revision });
      const next = {
        status: update.status ?? current.status,
        reply: update.reply === undefined ? current.reply : update.reply,
        staffNote: update.staffNote === undefined ? current.staffNote : update.staffNote,
      };
      const changedFields = (['status', 'reply', 'staffNote'] as const).filter(field => next[field] !== current[field]);
      if (!changedFields.length) return staffView(current);
      if (current.revision >= 2_147_483_647) throw new ConflictException('Feedback revision limit reached');
      const replied = changedFields.includes('reply');
      const row = (await tx.query<FeedbackRow>(`UPDATE "feedback" SET status=$2, reply=$3, "staffNote"=$4, "handledBy"=$5,
          "repliedAt"=CASE WHEN $6::boolean THEN (CASE WHEN $3::text IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END) ELSE "repliedAt" END,
          revision=revision+1, "updatedAt"=CURRENT_TIMESTAMP
        WHERE id=$1 RETURNING *`, [id, next.status, next.reply, next.staffNote, actorId, replied])).rows[0];
      if (!row) throw new NotFoundException();
      // Field names only: the reply and the note are user/staff text and stay out of the audit trail.
      await tx.model('operationLogs').create({ data: { module: 'feedback', action: 'update', status: 'SUCCESS', userId: actorId,
        targetId: id, targetType: 'feedback', method: 'PATCH', path: `/management/feedback/${id}`,
        metadata: { revision: row.revision, changedFields } } });
      if (replied && row.reply !== null && this.notifier) await this.notifier.notifyReply(tx as ApplicationTransaction, { userId: row.ownerId, feedbackId: row.id });
      return staffView(row);
    });
  }
}
