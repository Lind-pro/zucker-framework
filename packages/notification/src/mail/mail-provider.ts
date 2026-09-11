export interface SendMailOptions {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  from?: string;
  replyTo?: string;
  cc?: string | string[];
  bcc?: string | string[];
  attachments?: Array<{
    filename: string;
    content?: string | Buffer;
    path?: string;
    contentId?: string;
    contentType?: string;
  }>;
}
export const MailProviderErrorCode = {
  ABORTED: 'MAIL_DELIVERY_ABORTED',
  IDEMPOTENCY_UNSUPPORTED: 'MAIL_IDEMPOTENCY_UNSUPPORTED',
} as const;
export type MailProviderErrorCode =
  (typeof MailProviderErrorCode)[keyof typeof MailProviderErrorCode];
export interface MailDeliveryContext {
  idempotencyKey?: string;
  signal?: AbortSignal;
}
export interface SendMailResult {
  success: boolean;
  messageId?: string;
  error?: string;
  errorCode?: MailProviderErrorCode;
}
export interface MailProvider {
  readonly name: string;
  readonly supportsIdempotency: boolean;
  isConfigured(): boolean;
  deliver(options: SendMailOptions, context?: MailDeliveryContext): Promise<SendMailResult>;
  close(): Promise<void>;
}
export function abortedMailResult(): SendMailResult {
  return { success: false, error: '邮件发送已取消', errorCode: MailProviderErrorCode.ABORTED };
}
