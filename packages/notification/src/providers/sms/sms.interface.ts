export interface SmsMessage {
  /** 手机号 */
  phone: string;
  /** 短信模板 ID */
  templateId: string;
  /** 模板参数 */
  templateParams?: Record<string, string>;
  /** 签名（部分服务商必填） */
  signName?: string;
}

export interface SmsResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface SmsProvider {
  readonly name: string;
  send(message: SmsMessage): Promise<SmsResult>;
  sendBatch(messages: SmsMessage[]): Promise<SmsResult[]>;
}
