import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import type { SmsProvider, SmsMessage, SmsResult } from './sms.interface';

export interface TencentSmsOptions {
  secretId: string;
  secretKey: string;
  /** 短信应用 SDKAppID */
  sdkAppId: string;
  /** 短信签名 */
  signName: string;
  /** API 地域，默认 ap-guangzhou */
  region?: string;
}

/**
 * 腾讯云短信服务
 *
 * 使用腾讯云 SMS API v3 发送模板短信和验证码短信。
 * 需要在腾讯云控制台配置短信签名和模板。
 */
@Injectable()
export class TencentSmsProvider implements SmsProvider {
  private readonly logger = new Logger(TencentSmsProvider.name);
  readonly name = 'tencent';
  private readonly options: TencentSmsOptions;
  private readonly region: string;
  private readonly host = 'sms.tencentcloudapi.com';

  constructor(options: TencentSmsOptions) {
    this.options = options;
    this.region = options.region ?? 'ap-guangzhou';
    this.logger.log('腾讯云短信服务已初始化');
  }

  async send(message: SmsMessage): Promise<SmsResult> {
    try {
      const payload = {
        SmsSdkAppId: this.options.sdkAppId,
        SignName: message.signName ?? this.options.signName,
        TemplateId: message.templateId,
        TemplateParamSet: message.templateParams
          ? Object.values(message.templateParams)
          : [],
        PhoneNumberSet: [`+86${message.phone}`],
      };

      const body = JSON.stringify(payload);
      const headers = this.buildHeaders(body);

      const response = await fetch(`https://${this.host}`, {
        method: 'POST',
        headers,
        body,
      });

      const result = await response.json() as {
        Response?: {
          SendStatusSet?: Array<{ Code?: string; Message?: string; SerialNo?: string }>;
          Error?: { Code?: string; Message?: string };
        };
      };

      if (result.Response?.Error) {
        const err = result.Response.Error;
        this.logger.error(`腾讯云短信发送失败: ${err.Code} - ${err.Message}`);
        return { success: false, error: `${err.Code}: ${err.Message}` };
      }

      const sendResult = result.Response?.SendStatusSet?.[0];
      if (sendResult?.Code !== 'Ok') {
        this.logger.error(`腾讯云短信发送失败: ${sendResult?.Code} - ${sendResult?.Message}`);
        return { success: false, error: `${sendResult?.Code}: ${sendResult?.Message}` };
      }

      this.logger.log(`短信已发送: phone=${message.phone}, templateId=${message.templateId}`);
      return { success: true, messageId: sendResult.SerialNo };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(`腾讯云短信发送异常: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  async sendBatch(messages: SmsMessage[]): Promise<SmsResult[]> {
    return Promise.all(messages.map((m) => this.send(m)));
  }

  private buildHeaders(body: string): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const date = new Date(parseInt(timestamp) * 1000).toISOString().split('T')[0];
    const service = 'sms';

    // TC3-HMAC-SHA256 签名
    const hashedPayload = crypto.createHash('sha256').update(body).digest('hex');
    const httpRequestMethod = 'POST';
    const canonicalUri = '/';
    const canonicalQueryString = '';
    const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${this.host}\nx-tc-action:sendsms\n`;
    const signedHeaders = 'content-type;host;x-tc-action';

    const canonicalRequest = [
      httpRequestMethod,
      canonicalUri,
      canonicalQueryString,
      canonicalHeaders,
      signedHeaders,
      hashedPayload,
    ].join('\n');

    const credentialScope = `${date}/${service}/tc3_request`;
    const hashedCanonicalRequest = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
    const stringToSign = ['TC3-HMAC-SHA256', timestamp, credentialScope, hashedCanonicalRequest].join('\n');

    const secretDate = crypto.createHmac('sha256', `TC3${this.options.secretKey}`).update(date).digest();
    const secretService = crypto.createHmac('sha256', secretDate).update(service).digest();
    const secretSigning = crypto.createHmac('sha256', secretService).update('tc3_request').digest();
    const signature = crypto.createHmac('sha256', secretSigning).update(stringToSign).digest('hex');

    const authorization = `TC3-HMAC-SHA256 Credential=${this.options.secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return {
      'Content-Type': 'application/json; charset=utf-8',
      Host: this.host,
      'X-TC-Action': 'SendSms',
      'X-TC-Version': '2021-01-11',
      'X-TC-Timestamp': timestamp,
      'X-TC-Region': this.region,
      Authorization: authorization,
    };
  }
}
