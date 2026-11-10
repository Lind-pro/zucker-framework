import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import type { SmsProvider, SmsMessage, SmsResult } from './sms.interface';
import { maskPhoneNumber } from '../../delivery-log';

export interface AliyunSmsOptions {
  accessKeyId: string;
  accessKeySecret: string;
  /** 短信签名 */
  signName: string;
  /** API 端点，默认 dysmsapi.aliyuncs.com */
  endpoint?: string;
  /** Request timeout in milliseconds. Default 10000. */
  timeoutMs?: number;
}

/**
 * 阿里云短信服务
 *
 * 使用阿里云 SMS API 发送模板短信和验证码短信。
 * 需要在阿里云控制台配置短信签名和模板。
 */
@Injectable()
export class AliyunSmsProvider implements SmsProvider {
  private readonly logger = new Logger(AliyunSmsProvider.name);
  readonly name = 'aliyun';
  private readonly options: AliyunSmsOptions;
  private readonly endpoint: string;

  constructor(options: AliyunSmsOptions) {
    this.options = options;
    this.endpoint = options.endpoint ?? 'dysmsapi.aliyuncs.com';
    this.logger.log('阿里云短信服务已初始化');
  }

  async send(message: SmsMessage): Promise<SmsResult> {
    try {
      const params = this.buildRequestParams(message);
      const signature = this.sign(params);
      params['Signature'] = signature;

      const queryString = Object.entries(params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');

      const response = await fetch(`https://${this.endpoint}/?${queryString}`, {
        method: 'GET',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      });

      const result = await response.json() as { Code?: string; Message?: string; BizId?: string };

      if (result.Code !== 'OK') {
        this.logger.error(`阿里云短信发送失败: ${result.Code} - ${result.Message}`);
        return { success: false, error: `${result.Code}: ${result.Message}` };
      }

      this.logger.log(`短信已发送: phone=${maskPhoneNumber(message.phone)}, templateId=${message.templateId}`);
      return { success: true, messageId: result.BizId };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(`阿里云短信发送异常: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  async sendBatch(messages: SmsMessage[]): Promise<SmsResult[]> {
    return Promise.all(messages.map((m) => this.send(m)));
  }

  private buildRequestParams(message: SmsMessage): Record<string, string> {
    const timestamp = new Date().toISOString().replace(/\.\d{3}/, '');
    const nonce = Math.random().toString(36).substring(2, 15);

    return {
      Action: 'SendSms',
      Version: '2017-05-25',
      Format: 'JSON',
      AccessKeyId: this.options.accessKeyId,
      SignatureMethod: 'HMAC-SHA1',
      Timestamp: timestamp,
      SignatureVersion: '1.0',
      SignatureNonce: nonce,
      PhoneNumbers: message.phone,
      SignName: message.signName ?? this.options.signName,
      TemplateCode: message.templateId,
      TemplateParam: message.templateParams
        ? JSON.stringify(message.templateParams)
        : '{}',
    };
  }

  /**
   * 阿里云 API 签名
   */
  private sign(params: Record<string, string>): string {
    const sortedKeys = Object.keys(params).sort();
    const canonicalized = sortedKeys
      .map((k) => `${this.percentEncode(k)}=${this.percentEncode(params[k])}`)
      .join('&');

    const stringToSign = `GET&${this.percentEncode('/')}&${this.percentEncode(canonicalized)}`;
    const hmac = crypto.createHmac('sha1', `${this.options.accessKeySecret}&`);
    hmac.update(stringToSign);
    return hmac.digest('base64');
  }

  private percentEncode(str: string): string {
    return encodeURIComponent(str)
      .replace(/\+/g, '%20')
      .replace(/\*/g, '%2A')
      .replace(/%7E/g, '~');
  }
}
