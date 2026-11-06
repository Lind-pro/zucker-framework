import { MailHistoryService } from './mail-history.service';
import { tagMailLinks, type MailLinkTracking } from './mail-links';
import { Injectable, Logger, BadRequestException, type OnModuleDestroy } from '@nestjs/common';
import type { DatabaseAdapter } from '@zucker-framework/core';
import {
  MailProviderErrorCode,
  abortedMailResult,
  type MailProvider,
  type SendMailOptions,
  type SendMailResult,
  type MailDeliveryContext,
} from './mail-provider';
import {
  MailTemplateCatalog,
  extractMailVariables,
  type MailTemplateCatalogOptions,
  type ResolvedTemplate,
} from './template-catalog';
export type { ResolvedTemplate, BuiltInTemplateInfo } from './template-catalog';
export interface MailTemplateContent {
  from?: string;
  attachments?: SendMailOptions['attachments'];
  text?: string;
  [key: string]: unknown;
}
export type MailTemplateData = Record<string, unknown>;
export type MailRequestOptions = SendMailOptions & {
  template?: string;
  userId?: string;
  logMetadata?: Record<string, unknown>;
  delivery?: MailDeliveryContext;
};
export interface MailSendResult {
  success: boolean;
  error: string | null;
  errorCode?: MailProviderErrorCode;
  messageId?: string;
  provider?: string;
}
export interface MailServiceOptions {
  database: DatabaseAdapter;
  providers: MailProvider[];
  templates: Omit<MailTemplateCatalogOptions, 'database'>;
  historyModel?: string;
  defaultReplyTo?: string;
  minimumIntervalMs?: number;
  maxRetries?: number;
  recipientLocale?: (userId: string) => Promise<string | undefined>;
  renderContent?: (html: string, content?: MailTemplateContent) => string;
  logMetadata?: (
    metadata: Record<string, unknown>,
    context: { provider: string; template?: string; userId?: string },
  ) => Record<string, unknown>;
  /** Tags links to the consumer's own site so visits from an email can be attributed. */
  linkTracking?: MailLinkTracking;
}
interface SendSlotReservation {
  resolve: (acquired: boolean) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** One singleton owns email rate slots, cancellation, final delivery history and template rendering. */
@Injectable()
export class MailService implements OnModuleDestroy {
  readonly history: MailHistoryService;
  readonly templates: MailTemplateCatalog;
  private readonly logger = new Logger(MailService.name);
  private readonly defaultReplyTo?: string;
  private readonly minSendIntervalMs: number;
  private readonly maxSendRetry: number;
  private readonly sendSlotQueue: SendSlotReservation[] = [];
  private sendSlotTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSendStartedAt = Number.NEGATIVE_INFINITY;
  private stopped = false;
  private readonly shutdown = new AbortController();
  private readonly active = new Set<Promise<MailSendResult>>();

  constructor(private readonly options: MailServiceOptions) {
    this.history = new MailHistoryService(options.database, options.historyModel);
    this.templates = new MailTemplateCatalog({ ...options.templates, database: options.database });
    this.defaultReplyTo = options.defaultReplyTo;
    this.minSendIntervalMs = Math.max(0, options.minimumIntervalMs ?? 250);
    this.maxSendRetry = Math.max(0, Math.floor(options.maxRetries ?? 5));
    if (!Number.isFinite(this.minSendIntervalMs) || !Number.isFinite(this.maxSendRetry))
      throw new Error('Invalid mail delivery limits');
  }
  private getProvider() {
    return this.options.providers.find((provider) => provider.isConfigured()) ?? null;
  }

  async sendMailWithResult(options: MailRequestOptions): Promise<MailSendResult> {
    if (this.stopped) return { ...abortedMailResult(), error: '邮件发送已取消' };
    const signal = options.delivery?.signal
      ? AbortSignal.any([options.delivery.signal, this.shutdown.signal])
      : this.shutdown.signal;
    const pending = this.performSend({ ...options, delivery: { ...options.delivery, signal } });
    this.active.add(pending);
    try {
      return await pending;
    } finally {
      this.active.delete(pending);
    }
  }
  private buildLogMetadata(options: MailRequestOptions, provider: string) {
    let metadata: Record<string, unknown> = { ...options.logMetadata };
    if (options.replyTo) metadata.replyTo = options.replyTo;
    if (options.cc) metadata.cc = options.cc;
    if (options.bcc) metadata.bcc = options.bcc;
    metadata =
      this.options.logMetadata?.(metadata, {
        provider,
        template: options.template,
        userId: options.userId,
      }) ?? metadata;
    if (options.delivery?.idempotencyKey) metadata.idempotencyKey = options.delivery.idempotencyKey;
    // Validate/normalize before dispatch so malformed metadata cannot turn a sent email into a failed call.
    return Object.keys(metadata).length ? JSON.parse(JSON.stringify(metadata)) : undefined;
  }
  private tagLinks(options: MailRequestOptions): MailRequestOptions {
    const tracking = this.options.linkTracking;
    if (!tracking || typeof options.html !== 'string') return options;
    const campaignId = options.logMetadata?.campaignId;
    const params = tracking.params({
      template: options.template,
      campaignId: typeof campaignId === 'string' ? campaignId : undefined,
    });
    return params ? { ...options, html: tagMailLinks(options.html, tracking.origins, params) } : options;
  }
  async sendMail(options: MailRequestOptions): Promise<boolean> {
    return (await this.sendMailWithResult(options)).success;
  }

  /**
   * 发送邮件并返回详情（含错误原因），供群发做 429 限流重试判断。
   * provider 异常统一捕获为 { success:false, error }，调用方无需 try/catch。
   */
  private async performSend(options: MailRequestOptions): Promise<MailSendResult> {
    // 所有出站邮件的单一出口：集中校验 header 字段不含 CRLF，防 SMTP header injection
    this.assertSafeHeaders(options);
    if (
      options.delivery?.idempotencyKey &&
      !/^[A-Za-z0-9:_./-]{1,256}$/.test(options.delivery.idempotencyKey)
    ) {
      throw new BadRequestException('邮件幂等键格式无效');
    }

    const provider = this.getProvider();
    const recipient = Array.isArray(options.to) ? options.to.join(', ') : options.to;

    if (!provider) {
      this.logger.debug(
        `Mail delivery skipped: recipients=${Array.isArray(options.to) ? options.to.length : 1}`,
      );
      return { success: false, error: '邮件服务未启用' };
    }

    const metadata = this.buildLogMetadata(options, provider.name);
    options = this.tagLinks(options);

    // 全局节流 + 每秒 429 退避重试：
    //  - 每次尝试前预约发送时隙，限制启动速率不超过邮件商 req/s
    //  - 命中「每秒超限」429 → 指数退避重试（临时，必然恢复）
    //  - 「每日配额耗尽」→ 当天不可恢复，不重试（避免无谓重试 + 死循环）
    //  - 其它错误（硬退信、网络等）→ 不重试
    // 日志只在重试落定后写一次（避免把可重试的 429 误记为永久 failed）
    let result: SendMailResult = { success: false };
    if (options.delivery?.signal?.aborted) {
      result = {
        success: false,
        error: '邮件发送已取消',
        errorCode: MailProviderErrorCode.ABORTED,
      };
    } else if (options.delivery?.idempotencyKey && !provider.supportsIdempotency) {
      result = {
        success: false,
        error: `${provider.name} 不支持幂等投递`,
        errorCode: MailProviderErrorCode.IDEMPOTENCY_UNSUPPORTED,
      };
    } else {
      for (let attempt = 0; attempt <= this.maxSendRetry; attempt++) {
        if (!(await this.waitForSendSlot(options.delivery?.signal))) {
          result = {
            success: false,
            error: '邮件发送已取消',
            errorCode: MailProviderErrorCode.ABORTED,
          };
          break;
        }

        try {
          result = await provider.deliver(options, options.delivery);
        } catch (err) {
          result = {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }

        if (result.success) break;
        if (this.isPerSecondLimit(result.error) && attempt < this.maxSendRetry) {
          const backoff = 500 * 2 ** attempt; // 0.5/1/2/4/8s
          this.logger.warn(`邮件提供商每秒限流 429，第 ${attempt + 1} 次退避重试 (${backoff}ms)`);
          if (!(await this.waitForDeliveryDelay(backoff, options.delivery?.signal))) {
            result = {
              success: false,
              error: '邮件发送已取消',
              errorCode: MailProviderErrorCode.ABORTED,
            };
            break;
          }
          continue;
        }
        break; // 成功、每日配额、或其它错误 → 不再重试
      }
    }

    // 同步写邮件日志：失败时不阻断发送结果，但要 await 保证幂等去重能读到记录

    try {
      await this.options.database.model(this.options.historyModel ?? 'emailLogs').create({
        data: {
          userId: options.userId,
          recipient,
          subject: options.subject,
          template: options.template,
          provider: provider.name,
          messageId: result.messageId,
          status: result.success ? 'success' : 'failed',
          errorMessage: result.error,
          metadata,
        },
      });
    } catch (err) {
      // 日志写入失败不应阻断发送结果，但要打点排查
      this.logger.warn(`邮件日志写入失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {
      success: result.success,
      error: result.error ?? null,
      errorCode: result.errorCode,
      messageId: result.messageId,
      provider: provider.name,
    };
  }

  private waitForSendSlot(signal?: AbortSignal): Promise<boolean> {
    if (this.stopped || signal?.aborted) return Promise.resolve(false);

    return new Promise<boolean>((resolve) => {
      const reservation: SendSlotReservation = { resolve, signal };
      if (signal) {
        const onAbort = () => {
          const index = this.sendSlotQueue.indexOf(reservation);
          if (index < 0) return;

          this.sendSlotQueue.splice(index, 1);
          signal.removeEventListener('abort', onAbort);
          resolve(false);

          if (this.sendSlotQueue.length === 0 && this.sendSlotTimer) {
            clearTimeout(this.sendSlotTimer);
            this.sendSlotTimer = null;
          } else {
            this.dispatchSendSlotQueue();
          }
        };
        reservation.onAbort = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.sendSlotQueue.push(reservation);
      this.dispatchSendSlotQueue();
    });
  }

  private dispatchSendSlotQueue(): void {
    if (this.stopped || this.sendSlotTimer || this.sendSlotQueue.length === 0) return;

    const delay = Math.max(0, this.lastSendStartedAt + this.minSendIntervalMs - Date.now());
    if (delay > 0) {
      this.sendSlotTimer = setTimeout(() => {
        this.sendSlotTimer = null;
        this.dispatchSendSlotQueue();
      }, delay);
      return;
    }

    const reservation = this.sendSlotQueue[0];
    this.sendSlotQueue.splice(0, 1);
    if (reservation.signal && reservation.onAbort) {
      reservation.signal.removeEventListener('abort', reservation.onAbort);
    }
    this.lastSendStartedAt = Date.now();
    reservation.resolve(true);
    this.dispatchSendSlotQueue();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private async waitForDeliveryDelay(ms: number, signal?: AbortSignal): Promise<boolean> {
    if (!signal) {
      await this.sleep(ms);
      return true;
    }
    if (signal.aborted) return false;

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => finish(true), ms);
      const finish = (elapsed: boolean) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(elapsed);
      };
      const onAbort = () => finish(false);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** 每秒超限（可退避重试，必然恢复） */
  private isPerSecondLimit(error: string | undefined | null): boolean {
    if (!error || this.isDailyQuota(error)) return false;
    return /per second|too many requests|rate.?limit|\b429\b/i.test(error);
  }

  /** 每日配额耗尽（当天不可恢复，不重试） */
  isDailyQuota(error: string | undefined | null): boolean {
    if (!error) return false;
    return /daily|quota|limit reached|monthly/i.test(error);
  }

  private assertSafeHeaders(options: SendMailOptions): void {
    const headerValues: Array<string | undefined> = [
      options.subject,
      options.from,
      options.replyTo,
      ...(Array.isArray(options.to) ? options.to : [options.to]),
      ...(Array.isArray(options.cc) ? options.cc : options.cc ? [options.cc] : []),
      ...(Array.isArray(options.bcc) ? options.bcc : options.bcc ? [options.bcc] : []),
    ];
    for (const v of headerValues) {
      if (typeof v === 'string' && /[\r\n\0]/.test(v)) {
        throw new BadRequestException('邮件 header 含非法字符（换行/空字符）');
      }
    }
  }

  supportsIdempotentDelivery(): boolean {
    return this.getProvider()?.supportsIdempotency === true;
  }
  isMailEnabled(): boolean {
    return !this.stopped && !!this.getProvider();
  }
  isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }
  resolveTemplate(key: string): Promise<ResolvedTemplate> {
    return this.templates.resolve(key);
  }
  interpolate(html: string, data: MailTemplateData): string {
    return this.templates.interpolate(html, data);
  }
  listBuiltInTemplates() {
    return this.templates.listBuiltIns();
  }
  getBuiltInTemplateMeta(key: string) {
    return this.templates.getBuiltInMeta(key);
  }
  hasBuiltInTemplate(key: string) {
    return this.templates.hasBuiltIn(key);
  }
  getBuiltInTemplateHtml(key: string) {
    return this.templates.getBuiltInHtml(key);
  }
  getBuiltInTemplateVariant(key: string, locale: string) {
    return this.templates.getBuiltInVariant(key, locale);
  }
  private async resolveRecipientLocale(locale?: string, userId?: string) {
    if (locale?.trim() || !userId) return locale;
    try {
      return (await this.options.recipientLocale?.(userId)) ?? locale;
    } catch {
      this.logger.warn('Recipient locale lookup failed; using the default template locale');
      return locale;
    }
  }
  renderResolved(
    resolved: ResolvedTemplate,
    data: MailTemplateData,
    locale?: string,
    content?: MailTemplateContent,
  ): string {
    const html = this.interpolate(this.templates.select(resolved, locale), data);
    return this.options.renderContent?.(html, content) ?? html;
  }
  async renderTemplate(
    template: string,
    data: MailTemplateData,
    locale?: string,
    content?: MailTemplateContent,
  ): Promise<string> {
    return this.renderResolved(await this.resolveTemplate(template), data, locale, content);
  }
  async sendTemplateMail(
    to: string | string[],
    template: string,
    data: MailTemplateData,
    subject: string,
    userId?: string,
    logMetadata?: Record<string, unknown>,
    locale?: string,
  ): Promise<boolean> {
    const html = await this.renderTemplate(
      template,
      data,
      await this.resolveRecipientLocale(locale, userId),
    );
    return this.sendMail({
      to,
      subject,
      html,
      replyTo: this.defaultReplyTo,
      template,
      userId,
      logMetadata,
    });
  }
  async sendTemplateMailWithResult(
    to: string | string[],
    template: string,
    data: MailTemplateData,
    subject: string,
    userId?: string,
    logMetadata?: Record<string, unknown>,
    locale?: string,
    delivery?: MailDeliveryContext,
    content?: MailTemplateContent,
  ): Promise<MailSendResult> {
    const html = await this.renderTemplate(
      template,
      data,
      await this.resolveRecipientLocale(locale, userId),
      content,
    );
    return this.sendMailWithResult({
      to,
      subject,
      html,
      replyTo: this.defaultReplyTo,
      template,
      userId,
      logMetadata,
      delivery,
      from: content?.from,
      text: content?.text,
      attachments: content?.attachments?.filter(
        (attachment) => !attachment.contentId || html.includes(`src="cid:${attachment.contentId}"`),
      ),
    });
  }
  async sendResolved(
    to: string,
    template: string,
    resolved: ResolvedTemplate,
    data: MailTemplateData,
    subject: string,
    options: { userId?: string; locale?: string; campaignId?: string } = {},
  ): Promise<{ success: boolean; error: string | null }> {
    const missing = extractMailVariables(this.templates.select(resolved, options.locale)).filter(
      (key) => !Object.hasOwn(data, key),
    );
    if (missing.length)
      return {
        success: false,
        error: `邮件模板缺少业务数据：${missing.slice(0, 10).join(', ')}。请从对应业务流程发送。`,
      };
    return this.sendMailWithResult({
      to,
      subject,
      html: this.renderResolved(resolved, data, options.locale),
      replyTo: this.defaultReplyTo,
      template,
      userId: options.userId,
      logMetadata: options.campaignId ? { campaignId: options.campaignId } : undefined,
    });
  }
  async onModuleDestroy(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.shutdown.abort();
    if (this.sendSlotTimer) clearTimeout(this.sendSlotTimer);
    this.sendSlotTimer = null;
    for (const slot of this.sendSlotQueue.splice(0)) {
      if (slot.signal && slot.onAbort) slot.signal.removeEventListener('abort', slot.onAbort);
      slot.resolve(false);
    }
    await Promise.allSettled(this.options.providers.map((provider) => provider.close()));
    await Promise.allSettled([...this.active]);
  }
}
