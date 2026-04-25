import { CreditTransactionType as _CreditTransactionType } from './credit.service';

export {
  CreditTransactionType,
  CreditService,
  CREDIT_EVENT_TOPICS,
} from './credit.service';

export type {
  CreditQueryOptions,
  CreditQueryResult,
  CreditTransactionRecord,
  CreditEventPayload,
} from './credit.service';

export interface CreditTransaction {
  id: string;
  userId: string;
  type: _CreditTransactionType;
  amount: number;
  balance: number;
  description: string;
  expireAt: Date | null;
  orderId: string | null;
  expired: boolean;
  createdAt: Date;
}

export { ZuckerCreditModule } from './credit.module';
export type { CreditModuleAsyncOptions, CreditModuleAdapterFactory } from './credit.module';
