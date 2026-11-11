import { Logger } from '@nestjs/common';
import { PostgresCreditOperationCoordinator } from '@zucker-framework/credit';
import { createCreditLedger } from '../../billing/ledger';
import type { ApplicationDatabase, ApplicationTransaction } from '../../database';
import { AccountDeletionPostponedError, type AccountDeletionContributor } from './account-deletion.types';

/**
 * Built-in erase list for every table that holds a user's personal data at HEAD, by fixed parameterised
 * SQL so the deletion module needs no other feature module. Each statement is idempotent.
 *
 * Retained on purpose (accounting, D16/F21): `users` row (anonymised afterwards), billing_orders,
 * billing_subscriptions(+cycles), billing_fulfillments, billing_outbox, billing_refund_*, user_subscriptions,
 * user_subscription_payments, credit_account, credit_transaction, credit_lots, credit_holds(+allocations),
 * credit_consumptions/allocations, credit_operation_receipts, legacy credits/credit_transactions,
 * ai_tasks rows (prompt blanked, provider callback cleared), chats-independent job/task control rows
 * (async_jobs, async_job_events) and quota counters, public_assets (public site content, ownerId kept as
 * the anonymised id), site content authored by the user (createdBy kept), operation_logs rows (network
 * fields cleared), account_deletions (reason cleared).
 */
const TERMINAL_JOB = `('COMPLETED','FAILED','CANCELLED')`;

interface Identity { email: string | null; username: string }
async function identity(tx: ApplicationTransaction, userId: string): Promise<Identity | null> {
  const rows = await tx.query<Identity>('SELECT email, username FROM users WHERE id = $1', [userId]);
  return rows.rows[0] ?? null;
}

/** AI media tasks: waits for running tasks, keeps the rows (cost/audit), blanks prompts and drops outputs. */
export const aiTasksContributor: AccountDeletionContributor = {
  name: 'ai-tasks', order: 100,
  async erase(tx, userId) {
    const active = await tx.query(`SELECT task.id FROM ai_tasks AS task JOIN async_jobs AS job ON job.id = task.id
      WHERE task."ownerId" = $1 AND job.status NOT IN ${TERMINAL_JOB} LIMIT 1`, [userId]);
    if (active.rows.length) throw new AccountDeletionPostponedError('ai-tasks', 'a task is still running');
    await tx.query(`UPDATE async_jobs SET payload = jsonb_set(payload::jsonb, '{input,prompt}', '""'::jsonb), result = NULL
      WHERE id IN (SELECT id FROM ai_tasks WHERE "ownerId" = $1) AND payload::jsonb #> '{input,prompt}' IS NOT NULL
        AND payload::jsonb #>> '{input,prompt}' <> ''`, [userId]);
    await tx.query('UPDATE ai_tasks SET "callbackOutcome" = NULL WHERE "ownerId" = $1 AND "callbackOutcome" IS NOT NULL', [userId]);
    await tx.query('DELETE FROM ai_task_outputs WHERE "taskId" IN (SELECT id FROM ai_tasks WHERE "ownerId" = $1)', [userId]);
  },
};

/** Chats and messages (credits charged stay in the ledger). Waits for a streaming answer to settle. */
export const chatsContributor: AccountDeletionContributor = {
  name: 'chats', order: 110,
  async erase(tx, userId) {
    const streaming = await tx.query(`SELECT 1 FROM chat_messages WHERE "ownerId" = $1 AND status = 'STREAMING' LIMIT 1`, [userId]);
    if (streaming.rows.length) throw new AccountDeletionPostponedError('chats', 'an answer is still streaming');
    await tx.query('DELETE FROM chat_messages WHERE "ownerId" = $1', [userId]);
    await tx.query('DELETE FROM chats WHERE "ownerId" = $1', [userId]);
  },
};

/**
 * Generic record jobs: the user-supplied value lives in `job_records` and in the task payload/result.
 * Terminal tasks are blanked; a still-running one postpones the deletion.
 */
export const recordJobsContributor: AccountDeletionContributor = {
  name: 'record-jobs', order: 120,
  async erase(tx, userId) {
    const active = await tx.query(`SELECT 1 FROM async_jobs WHERE "userId" = $1 AND kind = 'record' AND status NOT IN ${TERMINAL_JOB} LIMIT 1`, [userId]);
    if (active.rows.length) throw new AccountDeletionPostponedError('record-jobs', 'a job is still running');
    await tx.query('DELETE FROM job_records WHERE "ownerId" = $1', [userId]);
    await tx.query(`UPDATE async_jobs SET payload = '{}'::jsonb, result = NULL WHERE "userId" = $1 AND kind = 'record'`, [userId]);
  },
};

/**
 * Private files: the avatar reference and avatar history go, every file becomes a tombstone (`deleted`,
 * cleanup `pending`) exactly as an owner deletion does; object removal is the file service's cleanup
 * (`privateFileCleanupContributor` after commit, or a later recovery). The tombstone keeps its file
 * name: identity columns of `file_assets` are immutable by trigger (private_files migration).
 */
export const filesContributor: AccountDeletionContributor = {
  name: 'files', order: 200,
  async erase(tx, userId) {
    await tx.query('UPDATE users SET "avatarFileId" = NULL WHERE id = $1 AND "avatarFileId" IS NOT NULL', [userId]);
    await tx.query('DELETE FROM account_avatar_changes WHERE "userId" = $1', [userId]);
    await tx.query(`UPDATE file_assets SET state = 'deleted', revision = revision + 1, "updatedAt" = now(), "deletedAt" = COALESCE("deletedAt", now()),
      "cleanupStatus" = 'pending', "cleanupConfirmedAt" = NULL WHERE "ownerId" = $1 AND state <> 'deleted'`, [userId]);
  },
};

/**
 * Remaining credits are expired through the canonical ledger (journal type EXPIRE, metadata reason
 * `account-deleted`) under the account lock; lots are never driven negative and the journal stays.
 */
export function creditsContributor(database: ApplicationDatabase): AccountDeletionContributor {
  const ledger = createCreditLedger(database);
  const coordinator = new PostgresCreditOperationCoordinator();
  return {
    name: 'credits', order: 300,
    async erase(tx, userId) {
      await coordinator.lockAccount(tx, userId);
      const now = new Date();
      const lots = await tx.query<{ id: string }>(`UPDATE credit_lots SET "expiresAt" = $2
        WHERE "userId" = $1 AND NOT "isExpired" AND "remainingAmount" > 0 AND ("expiresAt" IS NULL OR "expiresAt" > $2) RETURNING id`, [userId, now]);
      const due = await tx.query<{ id: string }>(`SELECT id FROM credit_lots WHERE "userId" = $1 AND NOT "isExpired" AND "remainingAmount" > 0`, [userId]);
      const ids = [...new Set([...lots.rows, ...due.rows].map(row => row.id))];
      if (!ids.length) return;
      await ledger.expireInTransaction(tx, { accountId: userId, lotIds: ids, transactionData: { type: 'EXPIRE',
        description: 'Expired at account deletion', metadata: { reason: 'account-deleted' } } }, now);
    },
  };
}

export const apiKeysContributor: AccountDeletionContributor = {
  name: 'api-keys', order: 400,
  async erase(tx, userId) {
    await tx.query('DELETE FROM account_api_key_usage WHERE "userId" = $1', [userId]);
    await tx.query('DELETE FROM account_api_keys WHERE "userId" = $1', [userId]);
  },
};

/** Sessions, tickets (including the cancel-deletion ticket), OAuth intents/proofs/bindings, legacy tokens. */
export const sessionsContributor: AccountDeletionContributor = {
  name: 'sessions', order: 500,
  async erase(tx, userId) {
    await tx.query('DELETE FROM account_oauth_proofs WHERE "userId" = $1 OR "sessionId" IN (SELECT id FROM account_sessions WHERE "userId" = $1)', [userId]);
    await tx.query('DELETE FROM account_oauth_intents WHERE "userId" = $1 OR "sessionId" IN (SELECT id FROM account_sessions WHERE "userId" = $1)', [userId]);
    await tx.query('DELETE FROM account_sessions WHERE "userId" = $1', [userId]);
    await tx.query('DELETE FROM account_tickets WHERE "userId" = $1', [userId]);
    await tx.query('DELETE FROM third_party_binds WHERE "userId" = $1', [userId]);
    await tx.query('DELETE FROM user_tokens WHERE "userId" = $1', [userId]);
  },
};

/** Role, permission, data-permission, dimension and settings links; notification subscriptions. */
export const authorizationContributor: AccountDeletionContributor = {
  name: 'authorization', order: 600,
  async erase(tx, userId) {
    for (const table of ['user_roles', 'user_permissions', 'user_data_permissions', 'dimension_users', 'user_settings', 'notify_subscribers']) {
      await tx.query(`DELETE FROM ${table} WHERE "userId" = $1`, [userId]);
    }
  },
};

export const signInHistoryContributor: AccountDeletionContributor = {
  name: 'sign-in-history', order: 700,
  async erase(tx, userId) {
    await tx.query('DELETE FROM user_login_history WHERE "userId" = $1', [userId]);
    await tx.query('DELETE FROM user_acquisition WHERE "userId" = $1', [userId]);
  },
};

export const twoFactorContributor: AccountDeletionContributor = {
  name: 'two-factor', order: 800,
  async erase(tx, userId) {
    await tx.query('DELETE FROM account_recovery_codes WHERE "userId" = $1', [userId]);
    await tx.query('DELETE FROM account_two_factor WHERE "userId" = $1', [userId]);
  },
};

/**
 * Mail and notification history addressed to the user, private delivery envelopes, and network
 * details in access/operation logs (rows of administrative audit stay, keyed by the anonymised id).
 */
export const logsContributor: AccountDeletionContributor = {
  name: 'logs', order: 900,
  async erase(tx, userId) {
    const who = await identity(tx, userId);
    const email = who?.email ?? null, username = who?.username ?? null;
    await tx.query('DELETE FROM email_logs WHERE "userId" = $1 OR ($2::text IS NOT NULL AND recipient = $2)', [userId, email]);
    await tx.query('DELETE FROM notify_history WHERE recipient = $1 OR ($2::text IS NOT NULL AND recipient = $2)', [userId, email]);
    await tx.query('DELETE FROM delivery_messages WHERE "ownerId" = $1', [userId]);
    await tx.query(`UPDATE access_logs SET username = NULL, ip = NULL, "userAgent" = NULL, parameters = NULL, result = NULL
      WHERE "userId" = $1 OR ($2::text IS NOT NULL AND username = $2)`, [userId, username]);
    await tx.query(`UPDATE operation_logs SET "ipAddress" = NULL, "userAgent" = NULL, "requestData" = NULL, "responseData" = NULL
      WHERE "userId" = $1`, [userId]);
  },
};

/** Built-ins that need only the database; `AccountDeletionModule` always registers them. */
export function builtInDeletionContributors(database: ApplicationDatabase): AccountDeletionContributor[] {
  return [aiTasksContributor, chatsContributor, recordJobsContributor, filesContributor, creditsContributor(database), apiKeysContributor,
    sessionsContributor, authorizationContributor, signInHistoryContributor, twoFactorContributor, logsContributor];
}

// ─── Service-backed contributors (registered by the integration through forRoot({ contributors })) ───

/** Structural view of `AITasksService.tasks` (`AITaskService<ApplicationTransaction>`). */
export interface AITaskCanceller { cancel(tx: ApplicationTransaction, ownerId: string, taskId: string): Promise<unknown> }

/**
 * Cancels the user's unfinished AI tasks through the AI task service on the caller's transaction (task
 * CANCELLED and credit hold released in one commit): at scheduling, and again right before erasing.
 * Without it, deletion waits for running tasks to reach a terminal state.
 */
export function aiTaskCancellationContributor(tasks: AITaskCanceller): AccountDeletionContributor {
  const cancelAll = async (tx: ApplicationTransaction, userId: string) => {
    const open = await tx.query<{ id: string }>(`SELECT task.id FROM ai_tasks AS task JOIN async_jobs AS job ON job.id = task.id
      WHERE task."ownerId" = $1 AND job.status NOT IN ${TERMINAL_JOB} ORDER BY task.id`, [userId]);
    for (const row of open.rows) await tasks.cancel(tx, userId, row.id);
  };
  return { name: 'ai-task-cancellation', order: 90, erase: cancelAll, onScheduled: cancelAll };
}

/** Structural view of `FilesService.recover`. */
export interface PrivateFileRecovery { recover(ownerId: string, id: string): Promise<unknown> }

/**
 * After the erase commit, removes the storage objects of the user's tombstoned files through the file
 * service's verified recovery (idempotent; a failure leaves `cleanupStatus = 'pending'` for later recovery).
 */
export function privateFileCleanupContributor(database: ApplicationDatabase, files: PrivateFileRecovery): AccountDeletionContributor {
  const logger = new Logger('AccountDeletionFiles');
  return {
    name: 'private-file-cleanup', order: 210,
    async erase() { /* tombstones are written by the built-in `files` contributor */ },
    async afterCommit(userId) {
      const pending = await database.transaction(tx => tx.query<{ id: string }>(
        `SELECT id FROM file_assets WHERE "ownerId" = $1 AND state = 'deleted' AND "cleanupStatus" IS DISTINCT FROM 'confirmed' ORDER BY id LIMIT 1000`, [userId]));
      let failed = 0;
      for (const row of pending.rows) {
        try { await files.recover(userId, row.id); } catch { failed++; }
      }
      if (failed) logger.warn(`Object cleanup of ${failed} deleted file(s) is pending; recovery can retry it`);
    },
  };
}
