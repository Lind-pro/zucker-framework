import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { ExtensionCore } from './core';
import type { ExtMailer, ExtServerOptions, ExtStore, StoreDelegate } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */

// In-memory store with unique keys, `include: { activations }` and an interactive $transaction that
// rolls back its own writes and serializes like a row lock would (one transaction at a time).
function createStore() {
  const tables: Record<string, any[]> = {
    extensionLicense: [],
    extensionActivation: [],
    extensionOrder: [],
    extensionFreeUsage: [],
    extensionProduct: [],
  };
  const unique: Record<string, string[]> = {
    extensionLicense: ['codeHash'],
    extensionActivation: ['tokenHash'],
    extensionOrder: ['stripeSessionId'],
    extensionFreeUsage: ['deviceId'],
    extensionProduct: ['slug'],
  };
  let seq = 0;
  const matches = (row: any, where: any) => Object.entries(where).every(([k, v]) => row[k] === v);
  const withInclude = (name: string, row: any, include: any) =>
    include?.activations && name === 'extensionLicense'
      ? { ...row, activations: tables.extensionActivation.filter((a) => a.licenseId === row.id).map((a) => ({ ...a })) }
      : { ...row };

  function delegate(name: string, undo?: Array<() => void>): StoreDelegate {
    const rows = tables[name];
    return {
      async findUnique({ where, include }: any) {
        await Promise.resolve();
        const row = rows.find((r) => matches(r, where));
        return row ? withInclude(name, row, include) : null;
      },
      async findMany(args: any = {}) {
        return rows.filter((r) => (args.where ? matches(r, args.where) : true)).map((r) => ({ ...r }));
      },
      async create({ data }: any) {
        await Promise.resolve();
        for (const key of unique[name]) {
          if (data[key] !== undefined && rows.some((r) => r[key] === data[key])) {
            throw Object.assign(new Error(`Unique constraint failed on ${key}`), { code: 'P2002' });
          }
        }
        const row = { id: `id-${(seq += 1)}`, createdAt: new Date(), ...data };
        rows.push(row);
        undo?.push(() => rows.splice(rows.indexOf(row), 1));
        return { ...row };
      },
      async update({ where, data }: any) {
        await Promise.resolve();
        const row = rows.find((r) => matches(r, where));
        if (!row) throw new Error('Record not found');
        const before = { ...row };
        Object.assign(row, data);
        undo?.push(() => Object.assign(row, before));
        return { ...row };
      },
      async upsert() {
        throw new Error('unused');
      },
      async count() {
        return rows.length;
      },
    };
  }

  let queue = Promise.resolve();
  const transactions = { started: 0 };
  const store: ExtStore & { tables: typeof tables; transactions: typeof transactions } = {
    tables,
    transactions,
    extensionLicense: delegate('extensionLicense'),
    extensionActivation: delegate('extensionActivation'),
    extensionOrder: delegate('extensionOrder'),
    extensionFreeUsage: delegate('extensionFreeUsage'),
    extensionProduct: delegate('extensionProduct'),
    $transaction(fn: (tx: ExtStore) => Promise<unknown>) {
      const run = queue.then(async () => {
        transactions.started += 1;
        const undo: Array<() => void> = [];
        const tx: ExtStore = {
          extensionLicense: delegate('extensionLicense', undo),
          extensionActivation: delegate('extensionActivation', undo),
          extensionOrder: delegate('extensionOrder', undo),
          extensionFreeUsage: delegate('extensionFreeUsage', undo),
          extensionProduct: delegate('extensionProduct', undo),
        };
        try {
          return await fn(tx);
        } catch (error) {
          undo.reverse().forEach((step) => step());
          throw error;
        }
      });
      queue = run.then(() => undefined, () => undefined);
      return run;
    },
  };
  return store;
}

const OPTIONS: ExtServerOptions = {
  licenseSecret: 'test-secret',
  stripeWebhookSecret: 'whsec_test',
  mailDomain: 'mail.test',
  defaultProduct: 'samplecapture',
  codePrefix: 'TESTPRO',
  proFeatures: ['unlimited'],
  fallbackProducts: {},
  fallbackBrand: { displayName: 'Pro', senderBrand: 'Brand' },
};

function stripeEvent(sessionId: string, overrides: Record<string, unknown> = {}) {
  const body = Buffer.from(
    JSON.stringify({
      id: `evt_${sessionId}`,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: sessionId,
          payment_status: 'paid',
          amount_total: 1900,
          currency: 'usd',
          customer_details: { email: 'buyer@test.dev' },
          client_reference_id: 'sampleexport',
          ...overrides,
        },
      },
    }),
  );
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', 'whsec_test').update(`${t}.`).update(body).digest('hex');
  return { body, header: `t=${t},v1=${sig}` };
}

function mailer(results: boolean[] = []): ExtMailer & { sent: { to: string; html: string }[] } {
  const sent: { to: string; html: string }[] = [];
  return {
    sent,
    async sendMail(message) {
      const ok = results.length ? results.shift()! : true;
      if (ok) sent.push(message);
      return ok;
    },
  };
}

describe('ExtensionCore webhook idempotency (H4)', () => {
  it('concurrent deliveries of one session mint and mail exactly one license', async () => {
    const store = createStore();
    const mail = mailer();
    const core = new ExtensionCore(store, mail, OPTIONS);
    const { body, header } = stripeEvent('cs_dup');
    const results = await Promise.all([
      core.handleStripeWebhook(body, header),
      core.handleStripeWebhook(body, header),
      core.handleStripeWebhook(body, header),
    ]);
    expect(results.filter((r) => !('duplicated' in r))).toHaveLength(1);
    expect(store.tables.extensionLicense).toHaveLength(1);
    expect(store.tables.extensionOrder).toHaveLength(1);
    expect(store.tables.extensionOrder[0]).toMatchObject({ status: 'fulfilled', licenseId: store.tables.extensionLicense[0].id });
    expect(mail.sent).toHaveLength(1);
  });

  it('a failed status write after mailing does not mint another code on retry', async () => {
    const store = createStore();
    const mail = mailer();
    const core = new ExtensionCore(store, mail, OPTIONS);
    const originalUpdate = store.extensionOrder.update;
    store.extensionOrder.update = async () => {
      throw new Error('connection reset');
    };
    const { body, header } = stripeEvent('cs_status');
    await expect(core.handleStripeWebhook(body, header)).resolves.toEqual({ received: true });
    store.extensionOrder.update = originalUpdate;
    await expect(core.handleStripeWebhook(body, header)).resolves.toEqual({ received: true, duplicated: true });
    expect(store.tables.extensionLicense).toHaveLength(1);
    expect(mail.sent).toHaveLength(1);
    // Delivery not confirmed in the database: stays visible to the admin resend flow.
    expect(store.tables.extensionOrder[0].status).toBe('email_failed');
  });

  it('a failed license insert rolls back the order claim so Stripe can retry', async () => {
    const store = createStore();
    const core = new ExtensionCore(store, mailer(), OPTIONS);
    const originalCreate = store.extensionLicense.create;
    let fail = true;
    const realTransaction = store.$transaction!;
    store.$transaction = (fn: (tx: ExtStore) => Promise<unknown>) =>
      realTransaction((tx: ExtStore) => {
        const create = tx.extensionLicense.create;
        tx.extensionLicense.create = async (args: any) => {
          if (fail) throw new Error('db down');
          return create(args);
        };
        return fn(tx);
      });
    const { body, header } = stripeEvent('cs_retry');
    await expect(core.handleStripeWebhook(body, header)).rejects.toThrow('db down');
    expect(store.tables.extensionOrder).toHaveLength(0);
    fail = false;
    store.extensionLicense.create = originalCreate;
    await expect(core.handleStripeWebhook(body, header)).resolves.toEqual({ received: true });
    expect(store.tables.extensionLicense).toHaveLength(1);
  });

  it('checkout policy ignores sessions outside the allow-list', async () => {
    const store = createStore();
    const mail = mailer();
    const core = new ExtensionCore(store, mail, {
      ...OPTIONS,
      checkout: { allowedProducts: ['sampleexport'], allowedPaymentLinks: ['plink_ok'] },
    });
    const other = stripeEvent('cs_saas', { client_reference_id: null, payment_link: null });
    await expect(core.handleStripeWebhook(other.body, other.header)).resolves.toEqual({ received: true, ignored: true });
    const wrongLink = stripeEvent('cs_link', { payment_link: 'plink_other' });
    await expect(core.handleStripeWebhook(wrongLink.body, wrongLink.header)).resolves.toEqual({ received: true, ignored: true });
    const ok = stripeEvent('cs_ok', { payment_link: 'plink_ok' });
    await expect(core.handleStripeWebhook(ok.body, ok.header)).resolves.toEqual({ received: true });
    expect(store.tables.extensionLicense).toHaveLength(1);

    const strict = new ExtensionCore(store, mail, { ...OPTIONS, checkout: { requireProductMetadata: true } });
    const noMeta = stripeEvent('cs_nometa');
    await expect(strict.handleStripeWebhook(noMeta.body, noMeta.header)).resolves.toEqual({ received: true, ignored: true });
  });

  it('works on a transaction client without $transaction (consumer-owned transaction)', async () => {
    const store = createStore();
    const { $transaction: _ignored, ...txLike } = store;
    const mail = mailer();
    const core = new ExtensionCore(txLike as ExtStore, mail, OPTIONS);
    const { body, header } = stripeEvent('cs_tx');
    await core.handleStripeWebhook(body, header);
    expect(store.tables.extensionOrder[0]).toMatchObject({ stripeSessionId: 'cs_tx', status: 'fulfilled' });
    expect(store.tables.extensionOrder[0].licenseId).toBe(store.tables.extensionLicense[0].id);
  });
});

describe('ExtensionCore admin resend (H7)', () => {
  async function paidOrder(results: boolean[]) {
    const store = createStore();
    const mail = mailer(results);
    const core = new ExtensionCore(store, mail, OPTIONS);
    const { body, header } = stripeEvent('cs_resend');
    await core.handleStripeWebhook(body, header);
    return { store, mail, core, order: store.tables.extensionOrder[0], original: store.tables.extensionLicense[0] };
  }

  it('keeps the working license and revokes the undelivered replacement when mail fails', async () => {
    const { store, core, order, original } = await paidOrder([true, false]);
    await expect(core.adminResendOrder(order.id)).rejects.toThrow('邮件发送失败');
    expect(original.status).toBe('active');
    expect(store.tables.extensionLicense).toHaveLength(2);
    expect(store.tables.extensionLicense[1].status).toBe('revoked');
    expect(order.licenseId).toBe(original.id);
  });

  it('revokes the previous license only after the replacement was delivered', async () => {
    const { store, core, order, original, mail } = await paidOrder([true, true]);
    const result = await core.adminResendOrder(order.id);
    expect(result.resent).toBe(true);
    expect(original.status).toBe('revoked');
    expect(order.licenseId).toBe(store.tables.extensionLicense[1].id);
    expect(mail.sent).toHaveLength(2);
  });
});

describe('ExtensionCore activation (M4)', () => {
  async function license(store: ReturnType<typeof createStore>, options = OPTIONS, maxDevices = 2) {
    const core = new ExtensionCore(store, mailer(), options);
    const { codes } = await core.createLicenses({ count: 1, maxDevices, durationDays: 365 });
    return { core, code: codes[0] };
  }

  it('parallel activations of different devices cannot exceed maxDevices', async () => {
    const store = createStore();
    const { core, code } = await license(store);
    const results = await Promise.allSettled(
      ['d1', 'd2', 'd3', 'd4', 'd5'].map((deviceId) => core.activate({ code, deviceId })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(store.tables.extensionActivation).toHaveLength(2);
  });

  it('license expiry anchor gives later devices the first activation expiry', async () => {
    const store = createStore();
    const { core, code } = await license(store, { ...OPTIONS, activationExpiry: 'license' });
    await core.activate({ code, deviceId: 'd1' });
    const first = store.tables.extensionActivation[0];
    first.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const second = await core.activate({ code, deviceId: 'd2' });
    expect(second.entitlement.expiresAt.getTime()).toBe(first.expiresAt.getTime());
  });

  it('default expiry stays per device', async () => {
    const store = createStore();
    const { core, code } = await license(store);
    await core.activate({ code, deviceId: 'd1' });
    store.tables.extensionActivation[0].expiresAt = new Date(Date.now() + 1000);
    const second = await core.activate({ code, deviceId: 'd2' });
    expect(second.entitlement.expiresAt.getTime()).toBeGreaterThan(Date.now() + 300 * 86400000);
  });
});

describe('ExtensionCore hardening (L8)', () => {
  it('license preview exposes only the prefix and two characters', async () => {
    const store = createStore();
    const core = new ExtensionCore(store, mailer(), OPTIONS);
    const { codes } = await core.createLicenses({ count: 1 });
    const preview = store.tables.extensionLicense[0].codePreview as string;
    expect(preview).toBe(`TESTPRO-…${codes[0].slice(-2)}`);
  });

  it('rejects an empty licenseSecret and clamps admin paging', async () => {
    expect(() => new ExtensionCore(createStore(), mailer(), { ...OPTIONS, licenseSecret: '' })).toThrow();
    const store = createStore();
    const core = new ExtensionCore(store, mailer(), OPTIONS);
    const findMany = store.extensionOrder.findMany;
    let args: any;
    store.extensionOrder.findMany = async (a: any) => {
      args = a;
      return findMany(a);
    };
    await core.adminListOrders(-3, 100000);
    expect(args).toMatchObject({ skip: 0, take: 100 });
  });
});

describe('ExtensionCore unique-violation handling (N13)', () => {
  /** Replaces the claim transaction with one that fails like a unique violation. */
  function failClaimWith(store: ReturnType<typeof createStore>, error: unknown, beforeThrow?: () => void) {
    store.$transaction = (async () => {
      beforeThrow?.();
      throw error;
    }) as never;
  }
  const violation = (extra: Record<string, unknown> = {}) =>
    Object.assign(new Error('Unique constraint failed'), { code: 'P2002', ...extra });

  it('rethrows a violation on another unique key (licence codeHash) so Stripe retries', async () => {
    const store = createStore();
    const mail = mailer();
    const core = new ExtensionCore(store, mail, OPTIONS);
    failClaimWith(store, violation({ meta: { target: ['codeHash'] } }));
    const { body, header } = stripeEvent('cs_hash');
    await expect(core.handleStripeWebhook(body, header)).rejects.toThrow('Unique constraint failed');
    expect(mail.sent).toHaveLength(0);
  });

  it('treats a violation naming stripeSessionId as a duplicate delivery', async () => {
    const store = createStore();
    const core = new ExtensionCore(store, mailer(), OPTIONS);
    failClaimWith(store, violation({ meta: { target: ['stripeSessionId'] } }));
    const { body, header } = stripeEvent('cs_session');
    await expect(core.handleStripeWebhook(body, header)).resolves.toEqual({ received: true, duplicated: true });
  });

  it('with an unnamed key, an existing order row means duplicate', async () => {
    const store = createStore();
    const core = new ExtensionCore(store, mailer(), OPTIONS);
    // The row appears after the fast-path lookup, as a concurrent delivery would commit it.
    failClaimWith(store, violation(), () => {
      store.tables.extensionOrder.push({ id: 'order-x', stripeSessionId: 'cs_unnamed', status: 'email_failed' });
    });
    const { body, header } = stripeEvent('cs_unnamed');
    await expect(core.handleStripeWebhook(body, header)).resolves.toEqual({ received: true, duplicated: true });
  });

  it('with an unnamed key and no order row, the error is rethrown', async () => {
    const store = createStore();
    const core = new ExtensionCore(store, mailer(), OPTIONS);
    failClaimWith(store, violation());
    const { body, header } = stripeEvent('cs_norow');
    await expect(core.handleStripeWebhook(body, header)).rejects.toThrow('Unique constraint failed');
  });

  it('logs a warning when a webhook secret is configured without a checkout policy', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      new ExtensionCore(createStore(), mailer(), OPTIONS);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('options.checkout'));
      warn.mockClear();
      new ExtensionCore(createStore(), mailer(), { ...OPTIONS, checkout: { allowedProducts: ['sampleexport'] } });
      new ExtensionCore(createStore(), mailer(), { ...OPTIONS, stripeWebhookSecret: undefined });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('ExtensionCore concurrent resend (N13)', () => {
  it('revokes both the stale previous licence and the one a concurrent resend installed', async () => {
    const store = createStore();
    const results: boolean[] = [true];
    const sent: unknown[] = [];
    const mail: ExtMailer = {
      async sendMail(message) {
        sent.push(message);
        // During the second (resend) mail, another resend repoints the order to its own licence.
        if (sent.length === 2) {
          store.tables.extensionLicense.push({ id: 'L_other', status: 'active', plan: 'pro', durationDays: 365, maxDevices: 2 });
          store.tables.extensionOrder[0].licenseId = 'L_other';
        }
        return results.length ? results.shift()! : true;
      },
    };
    const core = new ExtensionCore(store, mail, OPTIONS);
    const { body, header } = stripeEvent('cs_race');
    await core.handleStripeWebhook(body, header);
    const order = store.tables.extensionOrder[0];
    const previousId = order.licenseId as string;

    await expect(core.adminResendOrder(order.id)).resolves.toMatchObject({ resent: true });

    const byId = (id: string) => store.tables.extensionLicense.find((l) => l.id === id);
    expect(byId(previousId)!.status).toBe('revoked');
    expect(byId('L_other')!.status).toBe('revoked');
    const active = store.tables.extensionLicense.filter((l) => l.status === 'active');
    expect(active).toHaveLength(1);
    expect(order.licenseId).toBe(active[0].id);
    expect(order.status).toBe('fulfilled');
  });
});
