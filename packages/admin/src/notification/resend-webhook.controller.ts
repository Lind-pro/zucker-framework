import {
  Controller,
  Inject,
  Post,
  Req,
  Headers,
  HttpCode,
  HttpStatus,
  BadRequestException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Public } from '@zucker-framework/auth';
import { ResendWebhookService, type ResendEvent } from '@zucker-framework/notification';

export function createResendWebhookController(
  path: string,
): import('@nestjs/common').Type<{
  handle(
    req: { rawBody?: Buffer },
    headers: Record<string, string>,
  ): Promise<{ received: boolean }>;
}> {
  @Controller(path)
  class ResendWebhookController {
    constructor(
      @Inject(ResendWebhookService) private readonly webhookService: ResendWebhookService,
    ) {}

    @Public()
    @Post()
    @HttpCode(HttpStatus.OK)
    async handle(@Req() req: { rawBody?: Buffer }, @Headers() headers: Record<string, string>) {
      const rawBody = req.rawBody;
      if (!rawBody) {
        throw new BadRequestException('缺少请求体');
      }
      if (!this.webhookService.verifySignature(rawBody, headers)) {
        // 签名不通过 → 401，不泄漏细节
        throw new UnauthorizedException('签名校验失败');
      }

      let event: ResendEvent;
      try {
        event = JSON.parse(rawBody.toString('utf8'));
        if (
          !event ||
          typeof event !== 'object' ||
          Array.isArray(event) ||
          typeof event.type !== 'string' ||
          typeof event.data !== 'object' ||
          !event.data ||
          Array.isArray(event.data)
        )
          throw new Error('Invalid event');
      } catch {
        throw new BadRequestException('请求体不是合法 JSON');
      }

      // 数据库失败应返回 5xx，让 Resend 按有界重试策略重投，避免永久丢失事件。
      try {
        await this.webhookService.handleEvent(event);
      } catch {
        throw new ServiceUnavailableException('邮件事件暂时无法保存，请重试');
      }
      return { received: true };
    }
  }

  return ResendWebhookController;
}
