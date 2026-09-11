import type { MailService, MailTemplateData } from './mail.service';
import type { ResolvedTemplate } from './template-catalog';

export interface MailBatchRecipient {
  id: string;
  email: string;
  locale?: string;
  data: MailTemplateData;
}
export interface MailBatchOptions {
  template: string;
  subject: string;
  recipients: MailBatchRecipient[];
  failedSamples: Array<{ email: string; reason: string }>;
  resolved?: ResolvedTemplate;
  campaignId?: string;
  concurrency: number;
  deduplicationWindowMs: number;
}
/** Batch concurrency and short-window deduplication. Provider rate limiting stays in MailService. */
export async function dispatchMailBatch(mail: MailService, options: MailBatchOptions) {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1)
    throw new Error('Invalid mail concurrency');
  if (!options.recipients.length)
    return { attempted: 0, sent: 0, skipped: 0, quotaExhausted: false };
  const recent = new Set(
    await mail.history.sentUserIds(options.template, {
      since: new Date(Date.now() - options.deduplicationWindowMs),
      userIds: options.recipients.map((user) => user.id),
    }),
  );
  const recipients = options.recipients.filter((user) => !recent.has(user.id));
  const resolved = options.resolved ?? (await mail.resolveTemplate(options.template));
  let cursor = 0,
    attempted = 0,
    sent = 0;
  let quotaExhausted = false;
  const worker = async () => {
    while (cursor < recipients.length && !quotaExhausted) {
      const user = recipients[cursor++];
      attempted++;
      let result: { success: boolean; error: string | null };
      try {
        result = await mail.sendResolved(
          user.email,
          options.template,
          resolved,
          user.data,
          options.subject,
          { userId: user.id, locale: user.locale, campaignId: options.campaignId },
        );
      } catch (error) {
        result = { success: false, error: error instanceof Error ? error.message : String(error) };
      }
      if (result.success) {
        sent++;
        continue;
      }
      if (mail.isDailyQuota(result.error)) quotaExhausted = true;
      if (options.failedSamples.length < 50)
        options.failedSamples.push({
          email: user.email,
          reason: result.error ?? 'Mail delivery failed',
        });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, recipients.length) }, worker),
  );
  return { attempted, sent, skipped: options.recipients.length - attempted, quotaExhausted };
}
