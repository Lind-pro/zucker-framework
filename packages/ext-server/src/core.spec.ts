import { describe, expect, it, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { ExtensionCore } from './core';
import { verifyStripeSignature } from './stripe';
import type { ExtMailer, ExtServerOptions, ExtStore, StoreDelegate } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */

// 极简内存 store：只实现 core 用到的查询形态
function memDelegate(rows: any[], idField = 'id'): StoreDelegate & { rows: any[] } {
  let seq = 0;
  const matches = (row: any, where: any) =>
    Object.entries(where).every(([k, v]) => row[k] === v);
  return {
    rows,
    async findUnique({ where, include }: any) {
      const row = rows.find((r) => matches(r, where)) || null;
      return row ? { ...row, ...(include ? {} : {}) } : null;
    },
    async findMany(args: any = {}) {
      let out = rows.filter((r) => (args.where ? matches(r, args.where) : true));
      if (args.orderBy) out = [...out];
      return out.map((r) => ({ ...r }));
    },
    async create({ data }: any) {
      const row = { [idField]: `id-${(seq += 1)}`, createdAt: new Date(), ...data };
      rows.push(row);
      return { ...row };
    },
    async update({ where, data }: any) {
      const row = rows.find((r) => matches(r, where));
      Object.assign(row, data);
      return { ...row };
    },
    async upsert({ where, create, update }: any) {
      const row = rows.find((r) => matches(r, where));
      if (row) {
        Object.assign(row, update);
        return { ...row };
      }
      return this.create({ data: create });
    },
    async count() {
      return rows.length;
    },
  };
}

const OPTIONS: ExtServerOptions = {
  licenseSecret: 'test-secret',
  stripeWebhookSecret: 'whsec_test',
  mailDomain: 'mail.test',
  defaultProduct: 'siteshots',
  codePrefix: 'TESTPRO',
  proFeatures: ['unlimited'],
  fallbackProducts: {
    sitepdf: { displayName: 'SitePDF Pro', senderBrand: 'SitePDF' },
    siteshots: { displayName: 'SiteShots Pro', senderBrand: 'SiteShots' },
  },
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
          client_reference_id: 'sitepdf',
          ...overrides,
        },
      },
    }),
  );
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', 'whsec_test').update(`${t}.`).update(body).digest('hex');
  return { body, header: `t=${t},v1=${sig}` };
}

describe('ExtensionCore', () => {
  let store: ExtStore & Record<string, ReturnType<typeof memDelegate>>;
  let sentMails: { to: string; from?: string; subject: string }[];
  let mailer: ExtMailer;
  let core: ExtensionCore;

  beforeEach(() => {
    store = {
      extensionLicense: memDelegate([]),
      extensionActivation: memDelegate([]),
      extensionOrder: memDelegate([]),
      extensionFreeUsage: memDelegate([]),
      extensionProduct: memDelegate([], 'slug'),
    } as any;
    sentMails = [];
    mailer = {
      async sendMail(options) {
        sentMails.push(options);
        return true;
      },
    };
    core = new ExtensionCore(store, mailer, OPTIONS);
  });

  it('createLicenses 生成带前缀的码并可激活', async () => {
    const { codes } = await core.createLicenses({ count: 1, maxDevices: 1 });
    expect(codes[0]).toMatch(/^TESTPRO-/);

    // findUnique include activations 的形态：内存版补上关联
    const licenseRow = store.extensionLicense.rows[0];
    licenseRow.activations = [];
    const result = await core.activate({ code: codes[0], deviceId: 'dev-1' });
    expect(result.token).toBeTruthy();
    expect(result.entitlement.plan).toBe('pro');
    expect(store.extensionActivation.rows).toHaveLength(1);
  });

  it('激活超设备数被拒', async () => {
    const { codes } = await core.createLicenses({ count: 1, maxDevices: 1 });
    const licenseRow = store.extensionLicense.rows[0];
    licenseRow.activations = [];
    await core.activate({ code: codes[0], deviceId: 'dev-1' });
    licenseRow.activations = store.extensionActivation.rows;
    await expect(core.activate({ code: codes[0], deviceId: 'dev-2' })).rejects.toThrow(
      '设备数已满',
    );
  });

  it('webhook 验签发码 + 幂等 + 邮件用产品兜底品牌', async () => {
    const { body, header } = stripeEvent('cs_1');
    const first = await core.handleStripeWebhook(body, header);
    expect(first).toEqual({ received: true });
    expect(store.extensionOrder.rows).toHaveLength(1);
    expect(store.extensionOrder.rows[0].product).toBe('sitepdf');
    expect(sentMails[0].from).toBe('SitePDF <noreply@mail.test>');
    expect(sentMails[0].subject).toContain('SitePDF Pro');

    const again = await core.handleStripeWebhook(body, header);
    expect(again).toEqual({ received: true, duplicated: true });
    expect(store.extensionOrder.rows).toHaveLength(1);
  });

  it('webhook 产品信息优先取 ExtensionProduct 表', async () => {
    await store.extensionProduct.create({
      data: { slug: 'sitepdf', displayName: 'SitePDF Ultra', senderBrand: 'UltraPDF' },
    });
    const { body, header } = stripeEvent('cs_2');
    await core.handleStripeWebhook(body, header);
    expect(sentMails[0].from).toBe('UltraPDF <noreply@mail.test>');
    expect(sentMails[0].subject).toContain('SitePDF Ultra');
  });

  it('100% 折扣码订单（no_payment_required）也要发码', async () => {
    const { body, header } = stripeEvent('cs_free', {
      payment_status: 'no_payment_required',
      amount_total: 0,
    });
    await core.handleStripeWebhook(body, header);
    expect(store.extensionOrder.rows).toHaveLength(1);
    expect(store.extensionLicense.rows).toHaveLength(1);
    expect(sentMails).toHaveLength(1);
  });

  it('unpaid 订单不发码（等 async_payment_succeeded）', async () => {
    const { body, header } = stripeEvent('cs_unpaid', { payment_status: 'unpaid' });
    const result = await core.handleStripeWebhook(body, header);
    expect(result).toEqual({ received: true });
    expect(store.extensionOrder.rows).toHaveLength(0);
    expect(store.extensionLicense.rows).toHaveLength(0);
    expect(sentMails).toHaveLength(0);
  });

  it('webhook 签名错误被拒', async () => {
    const { body } = stripeEvent('cs_3');
    await expect(core.handleStripeWebhook(body, 't=1,v1=bad')).rejects.toThrow('签名');
  });

  it('consumeFree：当天一个账号，同号放行，换号拒绝', async () => {
    const first = await core.consumeFree({ deviceId: 'd1', accountId: 'acc-1', accountLabel: '公司A' });
    expect(first.allowed).toBe(true);
    const same = await core.consumeFree({ deviceId: 'd1', accountId: 'acc-1', accountLabel: '公司A' });
    expect(same.allowed).toBe(true);
    const switched = await core.consumeFree({ deviceId: 'd1', accountId: 'acc-2', accountLabel: '公司B' });
    expect(switched.allowed).toBe(false);
    expect((switched as { claimedLabel?: string }).claimedLabel).toBe('公司A');
  });

  it('adminStats 聚合各产品订单/收入/转化率与设备活跃', async () => {
    const { body, header } = stripeEvent('cs_s1');
    await core.handleStripeWebhook(body, header);
    const second = stripeEvent('cs_s2', { client_reference_id: 'siteshots', amount_total: 900 });
    await core.handleStripeWebhook(second.body, second.header);

    // 激活第一单的码 → sitepdf 转化率 100%，siteshots 0%
    const licenseId = store.extensionOrder.rows[0].licenseId;
    await store.extensionActivation.create({
      data: { licenseId, deviceId: 'd1', tokenHash: 'x', expiresAt: new Date(), lastSeenAt: new Date() },
    });

    const stats = await core.adminStats(30);
    const sitepdf = stats.products.find((p) => p.product === 'sitepdf');
    const siteshots = stats.products.find((p) => p.product === 'siteshots');
    expect(sitepdf).toMatchObject({ orders: 1, revenue: 1900, conversionRate: 100 });
    expect(siteshots).toMatchObject({ orders: 1, revenue: 900, conversionRate: 0 });
    expect(stats.devices).toMatchObject({ total: 1, active7d: 1 });
    expect(stats.licenses.total).toBe(2);
    expect(stats.daily.reduce((sum, d) => sum + d.orders, 0)).toBe(2);
  });
});

describe('verifyStripeSignature', () => {
  it('时间窗过期拒绝', () => {
    const body = Buffer.from('{}');
    const t = Math.floor(Date.now() / 1000) - 3600;
    const sig = createHmac('sha256', 's').update(`${t}.`).update(body).digest('hex');
    expect(verifyStripeSignature(body, `t=${t},v1=${sig}`, 's')).toBe(false);
  });

  it('多个 v1 候选中任一匹配即通过', () => {
    const body = Buffer.from('{"a":1}');
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', 's').update(`${t}.`).update(body).digest('hex');
    // 长度不同的候选被跳过、错误但等长的候选安全比较失败——正确签名在任意位置都应通过
    expect(verifyStripeSignature(body, `t=${t},v1=deadbeef,v1=${sig}`, 's')).toBe(true);
    const wrongSameLen = 'deadbeef'.padEnd(sig.length, '0');
    expect(verifyStripeSignature(body, `t=${t},v1=${wrongSameLen}`, 's')).toBe(false);
  });
});
