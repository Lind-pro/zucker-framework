import { createHash, randomBytes } from 'node:crypto';
import type { ModelOperations } from '@zucker-framework/core';

export interface OneTimeTicketRecord {
  id: string;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}
export interface OneTimeTicketStore<T extends OneTimeTicketRecord> {
  create(data: Record<string, unknown>): Promise<void>;
  find(tokenHash: string): Promise<T | null>;
  claim(id: string, now: Date): Promise<boolean>;
  cleanup(now: Date, consumedBefore: Date): Promise<void>;
}
export class DatabaseOneTimeTicketStore<T extends OneTimeTicketRecord> implements OneTimeTicketStore<T> {
  constructor(private readonly model: Pick<ModelOperations<T>, 'create' | 'findUnique' | 'updateMany' | 'deleteMany'>) {}
  async create(data: Record<string, unknown>) { await this.model.create({ data }); }
  find(tokenHash: string) { return this.model.findUnique({ where: { tokenHash } }); }
  async claim(id: string, now: Date) {
    const claimed = await this.model.updateMany({
      where: { id, consumedAt: null, expiresAt: { gt: now } }, data: { consumedAt: now },
    });
    return claimed.count === 1;
  }
  async cleanup(now: Date, consumedBefore: Date) {
    await this.model.deleteMany({ where: { OR: [
      { expiresAt: { lt: now } }, { consumedAt: { not: null }, createdAt: { lt: consumedBefore } },
    ] } });
  }
}
export class OneTimeTicketError extends Error {
  constructor(readonly reason: 'invalid' | 'consumed') {
    super(`One-time ticket ${reason}`); this.name = 'OneTimeTicketError';
  }
}
export class OneTimeTicketService<T extends OneTimeTicketRecord> {
  constructor(private readonly store: OneTimeTicketStore<T>, private readonly options: {
    expirySeconds: number;
    consumedRetentionSeconds: number;
    now?: () => Date;
  }) {}
  private hash(code: string) { return createHash('sha256').update(code).digest('hex'); }
  async issue(payload: Omit<T, keyof OneTimeTicketRecord>): Promise<string> {
    const code = randomBytes(32).toString('base64url');
    const now = this.options.now?.() ?? new Date();
    await this.store.cleanup(now, new Date(now.getTime() - this.options.consumedRetentionSeconds * 1000));
    await this.store.create({ ...payload, tokenHash: this.hash(code),
      expiresAt: new Date(now.getTime() + this.options.expirySeconds * 1000) });
    return code;
  }
  async consume(code: string): Promise<T> {
    const ticket = await this.store.find(this.hash(code));
    const now = this.options.now?.() ?? new Date();
    if (!ticket || ticket.consumedAt || ticket.expiresAt <= now) throw new OneTimeTicketError('invalid');
    if (!await this.store.claim(ticket.id, now)) throw new OneTimeTicketError('consumed');
    return ticket;
  }
}
