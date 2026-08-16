export interface CreditSqlQueryResult<TRow> {
  rows: TRow[];
}

export interface CreditSqlClient {
  query<TRow>(sql: string, parameters?: readonly unknown[]): Promise<CreditSqlQueryResult<TRow>>;
}

export interface CreditOperationInput {
  idempotencyKey: string;
  accountId: string;
  operationType: string;
  amount: number;
  resourceType: string;
  resourceId?: string;
}

export interface CreditOperationReceipt {
  idempotencyKey: string;
  accountId: string;
  operationType: string;
  amount: number;
  resourceType: string;
  resourceId?: string;
  createdAt: Date;
}

export interface PreparedCreditOperation {
  claimed: boolean;
  receipt: CreditOperationReceipt;
}

interface CreditOperationReceiptRow {
  idempotencyKey: string;
  accountId: string;
  operationType: string;
  amount: number;
  resourceType: string;
  resourceId: string | null;
  createdAt: Date | string;
}

export class CreditOperationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreditOperationValidationError';
  }
}

export class CreditOperationConflictError extends Error {
  constructor(idempotencyKey: string) {
    super(`Credit operation key ${idempotencyKey} was reused with different parameters`);
    this.name = 'CreditOperationConflictError';
  }
}

const LOCK_ACCOUNT_SQL = `
  INSERT INTO credit_account_locks ("accountId", "createdAt")
  VALUES ($1, $2)
  ON CONFLICT ("accountId") DO NOTHING
`;

const SELECT_ACCOUNT_LOCK_SQL = `
  SELECT "accountId"
  FROM credit_account_locks
  WHERE "accountId" = $1
  FOR UPDATE
`;

const CLAIM_OPERATION_SQL = `
  INSERT INTO credit_operation_receipts (
    "idempotencyKey", "accountId", "operationType", "amount",
    "resourceType", "resourceId", "createdAt"
  ) VALUES ($1, $2, $3, $4, $5, $6, $7)
  ON CONFLICT ("idempotencyKey") DO NOTHING
  RETURNING "idempotencyKey", "accountId", "operationType", "amount",
            "resourceType", "resourceId", "createdAt"
`;

const FIND_OPERATION_SQL = `
  SELECT "idempotencyKey", "accountId", "operationType", "amount",
         "resourceType", "resourceId", "createdAt"
  FROM credit_operation_receipts
  WHERE "idempotencyKey" = $1
  LIMIT 1
`;

function requiredText(name: string, value: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized) throw new CreditOperationValidationError(`${name} is required`);
  if (normalized.length > maxLength) {
    throw new CreditOperationValidationError(`${name} must not exceed ${maxLength} characters`);
  }
  return normalized;
}

function receiptFromRow(row: CreditOperationReceiptRow): CreditOperationReceipt {
  return {
    idempotencyKey: row.idempotencyKey,
    accountId: row.accountId,
    operationType: row.operationType,
    amount: Number(row.amount),
    resourceType: row.resourceType,
    resourceId: row.resourceId ?? undefined,
    createdAt: new Date(row.createdAt),
  };
}

/**
 * Coordinates credit writes inside a caller-owned PostgreSQL transaction.
 *
 * The lock and receipt must be committed in the same transaction as the
 * application's balance and ledger mutations. This class deliberately knows
 * nothing about plans, orders, patents, currencies or entitlement policy.
 */
export class PostgresCreditOperationCoordinator {
  async lockAccount(client: CreditSqlClient, accountId: string, now = new Date()): Promise<void> {
    const normalizedAccountId = requiredText('accountId', accountId, 191);
    await client.query(LOCK_ACCOUNT_SQL, [normalizedAccountId, now]);
    const locked = await client.query<{ accountId: string }>(SELECT_ACCOUNT_LOCK_SQL, [
      normalizedAccountId,
    ]);
    if (locked.rows.length !== 1) {
      throw new Error(`Credit account lock ${normalizedAccountId} could not be acquired`);
    }
  }

  async prepare(
    client: CreditSqlClient,
    input: CreditOperationInput,
    now = new Date(),
  ): Promise<PreparedCreditOperation> {
    const normalized = this.validate(input);
    await this.lockAccount(client, normalized.accountId, now);

    const inserted = await client.query<CreditOperationReceiptRow>(CLAIM_OPERATION_SQL, [
      normalized.idempotencyKey,
      normalized.accountId,
      normalized.operationType,
      normalized.amount,
      normalized.resourceType,
      normalized.resourceId ?? null,
      now,
    ]);
    if (inserted.rows[0]) {
      return { claimed: true, receipt: receiptFromRow(inserted.rows[0]) };
    }

    const existing = await client.query<CreditOperationReceiptRow>(FIND_OPERATION_SQL, [
      normalized.idempotencyKey,
    ]);
    const row = existing.rows[0];
    if (!row) {
      throw new Error(`Credit operation ${normalized.idempotencyKey} disappeared after conflict`);
    }
    if (!this.matches(row, normalized)) {
      throw new CreditOperationConflictError(normalized.idempotencyKey);
    }
    return { claimed: false, receipt: receiptFromRow(row) };
  }

  private validate(input: CreditOperationInput): CreditOperationInput {
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0 || input.amount > 2_147_483_647) {
      throw new CreditOperationValidationError('amount must be a positive 32-bit integer');
    }
    return {
      idempotencyKey: requiredText('idempotencyKey', input.idempotencyKey, 200),
      accountId: requiredText('accountId', input.accountId, 191),
      operationType: requiredText('operationType', input.operationType, 64),
      amount: input.amount,
      resourceType: requiredText('resourceType', input.resourceType, 64),
      resourceId: input.resourceId ? requiredText('resourceId', input.resourceId, 191) : undefined,
    };
  }

  private matches(row: CreditOperationReceiptRow, input: CreditOperationInput): boolean {
    return (
      row.accountId === input.accountId &&
      row.operationType === input.operationType &&
      Number(row.amount) === input.amount &&
      row.resourceType === input.resourceType &&
      (row.resourceId ?? undefined) === input.resourceId
    );
  }
}
