import {
  BadRequestException,
  ForbiddenException,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { verifyStripeSignature } from './stripe';
import type {
  ActivateInput,
  ConsumeFreeInput,
  CreateLicensesInput,
  ExtMailer,
  ExtServerOptions,
  ExtStore,
  ProductInfo,
} from './types';

// 应当发码的 checkout 支付状态。unpaid（如异步支付待确认）不在此列，
// 等 async_payment_succeeded 事件再处理。
const FULFILLABLE_PAYMENT_STATUSES = ['paid', 'no_payment_required'];

// Identifiers supplied by unauthenticated clients are bounded before they reach the database.
const MAX_CLIENT_ID_LENGTH = 256;

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'P2002' || code === '23505' || /unique constraint/i.test(String((error as Error)?.message));
}

// 浏览器扩展变现服务端核心：激活码授权（激活/权益/撤销/补发）、免费额度账本、
// Stripe webhook 发码、授权邮件、运营统计。产品维度全部参数化：
// 产品信息先查 ExtensionProduct 表，未登记时用 options.fallbackProducts 兜底。
export class ExtensionCore {
  protected readonly logger = new Logger(ExtensionCore.name);

  constructor(
    protected readonly store: ExtStore,
    protected readonly mailer: ExtMailer,
    protected readonly options: ExtServerOptions,
  ) {
    if (!options.licenseSecret) {
      throw new Error('ExtensionCore requires a non-empty licenseSecret');
    }
  }

  // Runs fn atomically when the store supports interactive transactions; a transaction client
  // (no $transaction) or a minimal store runs it directly.
  protected inTransaction<T>(fn: (store: ExtStore, atomic: boolean) => Promise<T>): Promise<T> {
    return this.store.$transaction
      ? this.store.$transaction((tx: ExtStore) => fn(tx, true))
      : fn(this.store, false);
  }

  // 激活码激活：绑定设备并下发短期 token
  async activate(dto: ActivateInput) {
    const code = this.normalizeCode(dto.code);
    const deviceId = (dto.deviceId || '').trim();
    if (!code || !deviceId) {
      throw new BadRequestException('激活码和设备标识不能为空');
    }

    if (deviceId.length > MAX_CLIENT_ID_LENGTH) {
      throw new BadRequestException('设备标识无效');
    }
    const codeHash = this.hash(code);

    // With a transactional store the device-limit check and the insert are serialized by a row lock on
    // the license (a same-value update), so parallel activations of different devices cannot exceed
    // maxDevices. Without one, the historical unlocked check applies.
    return this.inTransaction(async (store, atomic) => {
      let license = await store.extensionLicense.findUnique({
        where: { codeHash },
        include: { activations: true },
      });
      if (!license || license.status === 'revoked') {
        throw new ForbiddenException('激活码无效');
      }
      if (atomic) {
        await store.extensionLicense.update({ where: { id: license.id }, data: { id: license.id } });
        license = await store.extensionLicense.findUnique({
          where: { id: license.id },
          include: { activations: true },
        });
        if (!license || license.status === 'revoked') {
          throw new ForbiddenException('激活码无效');
        }
      }

      const now = new Date();
      const activations: Array<{ id: string; deviceId: string; expiresAt: Date; email?: string | null; deviceName?: string | null }> =
        license.activations || [];
      const existing = activations.find((a) => a.deviceId === deviceId);
      if (!existing && activations.length >= license.maxDevices) {
        throw new ForbiddenException('该激活码绑定设备数已满');
      }
      let expiresAt = this.addDays(now, license.durationDays);
      if (!existing && this.options.activationExpiry === 'license' && activations.length) {
        expiresAt = new Date(Math.min(...activations.map((a) => new Date(a.expiresAt).getTime())));
        if (expiresAt.getTime() <= now.getTime()) {
          throw new ForbiddenException('授权已过期');
        }
      }

      const token = randomBytes(32).toString('base64url');
      const activation = existing
        ? await store.extensionActivation.update({
            where: { id: existing.id },
            data: {
              tokenHash: this.hash(token),
              lastSeenAt: now,
              email: existing.email || (dto.email || '').trim(),
              deviceName: (dto.deviceName || existing.deviceName || '').trim(),
            },
          })
        : await store.extensionActivation.create({
            data: {
              licenseId: license.id,
              deviceId,
              email: (dto.email || '').trim(),
              deviceName: (dto.deviceName || '').trim(),
              tokenHash: this.hash(token),
              expiresAt,
              lastSeenAt: now,
            },
          });

      if (license.status !== 'active') {
        await store.extensionLicense.update({
          where: { id: license.id },
          data: { status: 'active' },
        });
      }

      return { token, entitlement: this.buildEntitlement(license, activation) };
    });
  }

  // 查询当前权益（Bearer token）
  async entitlement(token: string) {
    if (!token) {
      throw new UnauthorizedException('缺少授权 token');
    }

    const activation = await this.store.extensionActivation.findUnique({
      where: { tokenHash: this.hash(token) },
      include: { license: true },
    });
    if (!activation) {
      throw new UnauthorizedException('授权 token 无效');
    }
    if (
      activation.license.status === 'revoked' ||
      activation.expiresAt.getTime() <= Date.now()
    ) {
      throw new ForbiddenException('授权已过期或已被撤销');
    }

    await this.store.extensionActivation.update({
      where: { id: activation.id },
      data: { lastSeenAt: new Date() },
    });
    return { entitlement: this.buildEntitlement(activation.license, activation) };
  }

  // 免费额度账本：每台设备每天可免费导出一个账号，换号需激活
  async consumeFree(dto: ConsumeFreeInput) {
    const deviceId = (dto.deviceId || '').trim();
    const accountKey = (dto.accountId || '').trim();
    const accountLabel = (dto.accountLabel || '').trim() || accountKey;
    if (!deviceId || !accountKey) {
      throw new BadRequestException('设备标识和账号标识不能为空');
    }
    if (
      deviceId.length > MAX_CLIENT_ID_LENGTH ||
      accountKey.length > MAX_CLIENT_ID_LENGTH ||
      accountLabel.length > MAX_CLIENT_ID_LENGTH
    ) {
      throw new BadRequestException('设备标识或账号标识过长');
    }

    const today = this.today();
    const current = await this.store.extensionFreeUsage.findUnique({
      where: { deviceId },
    });

    // 当天未认领 → 认领当前账号
    if (!current || current.date !== today) {
      await this.store.extensionFreeUsage.upsert({
        where: { deviceId },
        create: { deviceId, date: today, accountKey, accountLabel },
        update: { date: today, accountKey, accountLabel },
      });
      return { allowed: true, accountKey, accountLabel };
    }

    // 同一账号 → 放行（当天不限次数）。key 或昵称任一匹配即视为同号，
    // 兼容历史版本用账号 ID 作 key 的记录，并顺手迁移为当前 key。
    const sameAccount =
      current.accountKey === accountKey ||
      current.accountKey === accountLabel ||
      (current.accountLabel &&
        (current.accountLabel === accountLabel || current.accountLabel === accountKey));
    if (sameAccount) {
      await this.store.extensionFreeUsage.update({
        where: { deviceId },
        data: { accountKey, accountLabel },
      });
      return { allowed: true, accountKey, accountLabel };
    }

    // 换了账号 → 拒绝
    return {
      allowed: false,
      reason: `今日免费额度已用于账号「${current.accountLabel || current.accountKey}」，换号导出其他账号需激活 Pro`,
      claimedLabel: current.accountLabel || current.accountKey,
    };
  }

  // 管理端：批量生成激活码（明文仅此一次返回）
  async createLicenses(dto: CreateLicensesInput) {
    const count = Math.min(Math.max(dto.count || 1, 1), 100);
    const codes: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const { code } = await this.createLicense({
        plan: dto.plan,
        durationDays: dto.durationDays,
        maxDevices: dto.maxDevices,
        features: dto.features,
      });
      codes.push(code);
    }
    return { codes };
  }

  private async createLicense(
    input: {
      plan?: string;
      durationDays?: number;
      maxDevices?: number;
      features?: string[];
    },
    store: ExtStore = this.store,
  ) {
    const code = this.generateCode();
    const license = await store.extensionLicense.create({
      data: {
        codeHash: this.hash(this.normalizeCode(code)),
        codePreview: this.previewCode(code),
        plan: input.plan || 'pro',
        durationDays: input.durationDays || 365,
        maxDevices: input.maxDevices || 1,
        features: input.features?.length ? input.features : this.options.proFeatures,
        status: 'active',
      },
    });
    return { code, license };
  }

  // Stripe webhook：验签 → checkout 完成 → 幂等发码 → 邮件送达
  async handleStripeWebhook(rawBody: Buffer | undefined, signature: string) {
    const secret = this.options.stripeWebhookSecret;
    if (!secret) {
      throw new ServiceUnavailableException('Stripe webhook 未配置');
    }
    if (!rawBody?.length) {
      throw new BadRequestException('缺少请求体');
    }
    if (!verifyStripeSignature(rawBody, signature || '', secret)) {
      throw new UnauthorizedException('Stripe 签名校验失败');
    }

    const event = JSON.parse(rawBody.toString('utf8'));
    const type = String(event?.type || '');
    if (
      type !== 'checkout.session.completed' &&
      type !== 'checkout.session.async_payment_succeeded'
    ) {
      return { received: true };
    }

    const session = event.data?.object || {};
    // no_payment_required：100% 折扣码/赠送等免费订单，Stripe 不会标记为 paid，
    // 但同样需要发码——只认 paid 会让免费订单静默跳过，用户收不到码且后台无记录。
    if (session.payment_status && !FULFILLABLE_PAYMENT_STATUSES.includes(session.payment_status)) {
      return { received: true };
    }
    const sessionId = String(session.id || '');
    if (!sessionId) {
      return { received: true };
    }

    // Fast path for Stripe retries. The authoritative idempotency guard is the unique order row below.
    const existing = await this.store.extensionOrder.findUnique({
      where: { stripeSessionId: sessionId },
    });
    if (existing) {
      return { received: true, duplicated: true };
    }

    const metadata = session.metadata || {};
    const email: string = session.customer_details?.email || session.customer_email || '';
    // Payment Link 界面不支持 session metadata：产品来源优先 metadata（未来经 API 设置时），
    // 否则取 Payment Link URL 拼接的 ?client_reference_id=<slug>，最后落 defaultProduct。
    const product = String(
      metadata.product || session.client_reference_id || this.options.defaultProduct,
    ).toLowerCase();
    if (!(await this.acceptsCheckout(session, product))) {
      this.logger.warn(`Ignoring checkout session outside the extension checkout policy: session=${sessionId}`);
      return { received: true, ignored: true };
    }

    // Claim the session first: the order row (unique stripeSessionId) is inserted before the license and
    // in the same transaction, so concurrent or repeated deliveries mint at most one code. The order stays
    // `email_failed` until delivery is confirmed, which keeps a crash or mail failure visible to admin resend.
    let claimed: { code: string; license: { id: string; codePreview: string } };
    try {
      claimed = await this.inTransaction(async (store) => {
        await store.extensionOrder.create({
          data: {
            stripeSessionId: sessionId,
            stripeEventId: String(event.id || ''),
            product,
            email,
            amountTotal: Number(session.amount_total) || null,
            currency: String(session.currency || '') || null,
            status: 'email_failed',
          },
        });
        const created = await this.createLicense(
          {
            plan: String(metadata.plan || 'pro'),
            durationDays: Number(metadata.durationDays) || 365,
            maxDevices: Number(metadata.maxDevices) || 2,
          },
          store,
        );
        await store.extensionOrder.update({
          where: { stripeSessionId: sessionId },
          data: { licenseId: created.license.id, licenseCodePreview: created.license.codePreview },
        });
        return created;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return { received: true, duplicated: true };
      }
      throw error;
    }
    const { code, license } = claimed;

    if (!email) {
      this.logger.error(`Stripe session 无买家邮箱: session=${sessionId}`);
      return { received: true };
    }
    const sent = await this.sendLicenseEmail(email, code, product).catch((error) => {
      this.logger.error(`激活码邮件发送异常: ${(error as Error)?.message}`);
      return false;
    });
    if (!sent) {
      this.logger.error(
        `激活码邮件发送失败，需人工补发: session=${sessionId} license=${license.id}`,
      );
      return { received: true };
    }
    // The code is already delivered: a failed status write must not make Stripe retry (the retry would be
    // a duplicate anyway). The order stays `email_failed` and an operator can confirm or resend.
    await this.store.extensionOrder
      .update({ where: { stripeSessionId: sessionId }, data: { status: 'fulfilled' } })
      .catch((error) => {
        this.logger.error(
          `激活码已发送但订单状态未更新: session=${sessionId} error=${(error as Error)?.message}`,
        );
      });

    return { received: true };
  }

  protected async acceptsCheckout(session: Record<string, any>, product: string): Promise<boolean> {
    const policy = this.options.checkout;
    if (!policy) {
      return true;
    }
    if (policy.requireProductMetadata && !session.metadata?.product) {
      return false;
    }
    if (policy.allowedProducts && !policy.allowedProducts.map((p) => p.toLowerCase()).includes(product)) {
      return false;
    }
    if (policy.allowedPaymentLinks) {
      const link = session.payment_link;
      const linkId = typeof link === 'string' ? link : link?.id;
      if (!linkId || !policy.allowedPaymentLinks.includes(linkId)) {
        return false;
      }
    }
    return policy.accept ? Boolean(await policy.accept(session, product)) : true;
  }

  // 产品信息：先查 ExtensionProduct 表（新产品只需插一行 DB），
  // 未登记时用 fallbackProducts 子串匹配兜底（保持历史行为）
  protected async productInfo(product: string | null | undefined): Promise<ProductInfo> {
    const key = String(product || '').toLowerCase();
    if (key) {
      const row = await this.store.extensionProduct.findUnique({ where: { slug: key } });
      if (row) {
        return { displayName: row.displayName, senderBrand: row.senderBrand };
      }
    }
    for (const [slug, info] of Object.entries(this.options.fallbackProducts)) {
      if (key.includes(slug)) {
        return info;
      }
    }
    return this.options.fallbackBrand;
  }

  protected async sendLicenseEmail(to: string, code: string, product: string) {
    const info = await this.productInfo(product);
    return this.mailer.sendMail({
      to,
      from: `${info.senderBrand} <noreply@${this.options.mailDomain}>`,
      subject: `Your ${info.displayName} activation code`,
      html: [
        `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;color:#1d2333">`,
        `<h2 style="color:#4353d9">Thanks for purchasing ${info.displayName}!</h2>`,
        `<p>Your activation code:</p>`,
        `<p style="font-size:20px;font-weight:700;letter-spacing:1px;background:#f2f4fb;border:1px solid #dfe4f0;border-radius:8px;padding:14px 18px">${code}</p>`,
        `<p><b>How to activate</b></p>`,
        `<ol>`,
        `<li>Open the extension popup in your browser</li>`,
        `<li>Click <b>Go Pro / Activate</b> and paste the code above</li>`,
        `</ol>`,
        `<p style="color:#5c6579;font-size:13px">Keep this email — the code is shown only here. ` +
          `Need help? Just reply to this email.</p>`,
        `</div>`,
      ].join(''),
    });
  }

  // ===== 管理端（消费方 controller 负责鉴权） =====

  async adminListLicenses(page: number, pageSize: number) {
    ({ page, pageSize } = this.pageArgs(page, pageSize));
    const skip = (page - 1) * pageSize;
    const [items, total] = await Promise.all([
      this.store.extensionLicense.findMany({
        skip,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: {
          activations: {
            select: { deviceName: true, email: true, activatedAt: true, expiresAt: true },
          },
        },
      }),
      this.store.extensionLicense.count(),
    ]);
    return {
      total,
      items: items.map((license) => ({
        id: license.id,
        codePreview: license.codePreview,
        plan: license.plan,
        durationDays: license.durationDays,
        maxDevices: license.maxDevices,
        status: license.status,
        createdAt: license.createdAt,
        activationCount: license.activations.length,
        activations: license.activations,
      })),
    };
  }

  async adminListOrders(page: number, pageSize: number) {
    ({ page, pageSize } = this.pageArgs(page, pageSize));
    const skip = (page - 1) * pageSize;
    const [items, total] = await Promise.all([
      this.store.extensionOrder.findMany({
        skip,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
      }),
      this.store.extensionOrder.count(),
    ]);
    return { total, items };
  }

  async adminRevokeLicense(id: string) {
    await this.store.extensionLicense.update({
      where: { id },
      data: { status: 'revoked' },
    });
    return { revoked: true };
  }

  // 补发：明文码不落库无法重发原码，生成同规格新码并邮件送达，订单指向新码
  async adminResendOrder(id: string) {
    const order = await this.store.extensionOrder.findUnique({ where: { id } });
    if (!order) {
      throw new BadRequestException('订单不存在');
    }
    if (!order.email) {
      throw new BadRequestException('该订单没有买家邮箱，无法补发');
    }

    const previous = order.licenseId
      ? await this.store.extensionLicense.findUnique({ where: { id: order.licenseId } })
      : null;
    const { code, license } = await this.createLicense({
      plan: previous?.plan,
      durationDays: previous?.durationDays,
      maxDevices: previous?.maxDevices,
    });

    // Deliver first: the customer's current license stays valid until the replacement has been sent.
    const sent = await this.sendLicenseEmail(order.email, code, order.product || '').catch(
      () => false,
    );
    if (!sent) {
      await this.store.extensionLicense
        .update({ where: { id: license.id }, data: { status: 'revoked' } })
        .catch((error) => {
          this.logger.error(`补发失败后撤销新码失败: license=${license.id} error=${(error as Error)?.message}`);
        });
      throw new ServiceUnavailableException('邮件发送失败，请检查邮件服务配置');
    }

    await this.inTransaction(async (store) => {
      if (previous && previous.id !== license.id) {
        await store.extensionLicense.update({
          where: { id: previous.id },
          data: { status: 'revoked' },
        });
      }
      await store.extensionOrder.update({
        where: { id },
        data: {
          licenseId: license.id,
          licenseCodePreview: license.codePreview,
          status: 'fulfilled',
        },
      });
    });
    return { resent: true, codePreview: license.codePreview };
  }

  // 运营统计：只用已有订单/激活数据聚合，不依赖任何插件端采集
  async adminStats(days = 30) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [orders, licenses, activations] = await Promise.all([
      this.store.extensionOrder.findMany({
        select: {
          product: true,
          amountTotal: true,
          currency: true,
          status: true,
          licenseId: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.store.extensionLicense.findMany({ select: { id: true, status: true } }),
      this.store.extensionActivation.findMany({
        select: { licenseId: true, lastSeenAt: true },
      }),
    ]);

    const activatedLicenseIds = new Set(activations.map((a) => a.licenseId));

    interface ProductAgg {
      product: string;
      orders: number;
      revenue: number;
      currency: string;
      emailFailed: number;
      activatedOrders: number;
    }
    const byProduct = new Map<string, ProductAgg>();
    const dailyMap = new Map<string, { date: string; orders: number; revenue: number }>();
    for (const order of orders) {
      const product = order.product || 'unknown';
      const agg =
        byProduct.get(product) ||
        ({ product, orders: 0, revenue: 0, currency: '', emailFailed: 0, activatedOrders: 0 } as ProductAgg);
      agg.orders += 1;
      agg.revenue += order.amountTotal || 0;
      agg.currency = order.currency || agg.currency;
      if (order.status === 'email_failed') {
        agg.emailFailed += 1;
      }
      if (order.licenseId && activatedLicenseIds.has(order.licenseId)) {
        agg.activatedOrders += 1;
      }
      byProduct.set(product, agg);

      if (order.createdAt >= since) {
        const date = order.createdAt.toISOString().slice(0, 10);
        const day = dailyMap.get(date) || { date, orders: 0, revenue: 0 };
        day.orders += 1;
        day.revenue += order.amountTotal || 0;
        dailyMap.set(date, day);
      }
    }

    return {
      products: [...byProduct.values()].map((agg) => ({
        ...agg,
        // 发码→激活转化率：买了却没激活的用户是流失/求助信号
        conversionRate: agg.orders ? Math.round((agg.activatedOrders / agg.orders) * 100) : 0,
      })),
      daily: [...dailyMap.values()],
      licenses: {
        total: licenses.length,
        active: licenses.filter((l) => l.status === 'active').length,
        revoked: licenses.filter((l) => l.status === 'revoked').length,
        activated: licenses.filter((l) => activatedLicenseIds.has(l.id)).length,
      },
      devices: {
        total: activations.length,
        active7d: activations.filter((a) => a.lastSeenAt >= sevenDaysAgo).length,
      },
    };
  }

  private hash(value: string) {
    return createHash('sha256').update(`${this.options.licenseSecret}:${value}`).digest('hex');
  }

  private normalizeCode(value: string) {
    return String(value || '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
  }

  // Only the prefix and the last two characters: the code has 48 random bits, the preview is returned
  // to clients and logged, and must not shrink the secret part meaningfully.
  private previewCode(code: string) {
    return `${code.slice(0, this.options.codePrefix.length + 1)}…${code.slice(-2)}`;
  }

  private pageArgs(page: number, pageSize: number) {
    const safePage = Number.isInteger(Number(page)) && Number(page) >= 1 ? Number(page) : 1;
    const size = Number.isInteger(Number(pageSize)) ? Number(pageSize) : 20;
    return { page: safePage, pageSize: Math.min(Math.max(size, 1), 100) };
  }

  private generateCode() {
    const block = () => randomBytes(2).toString('hex').toUpperCase();
    return `${this.options.codePrefix}-${block()}-${block()}-${block()}`;
  }

  private addDays(date: Date, days: number) {
    return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
  }

  private today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  private buildEntitlement(
    license: { plan: string; features: string[]; codePreview: string | null },
    activation: { expiresAt: Date; email: string | null },
  ) {
    return {
      active: true,
      plan: license.plan || 'pro',
      features: license.features?.length ? license.features : this.options.proFeatures,
      expiresAt: activation.expiresAt,
      email: activation.email || '',
      licenseCode: license.codePreview || '',
    };
  }
}
