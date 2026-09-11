// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'crypto';
import { ResendWebhookService } from './resend-webhook.service';
import { MailEngagementService } from './mail-engagement.service';

const SECRET_B64 = Buffer.from('super-secret-bytes-for-test').toString('base64');
const SECRET = `whsec_${SECRET_B64}`;

function signedHeaders(id: string, ts: string, body: string) {
  const secretBytes = Buffer.from(SECRET_B64, 'base64');
  const sig = crypto
    .createHmac('sha256', secretBytes)
    .update(`${id}.${ts}.${body}`)
    .digest('base64');
  return { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` };
}

describe('ResendWebhookService', () => {
  let suppress: ReturnType<typeof vi.fn>;
  let service: ResendWebhookService;

  const make = (secret = SECRET) => {
    suppress = vi.fn().mockResolvedValue({ count: 1 });
    return new ResendWebhookService({ signingSecret: secret, suppressRecipients: suppress }, {
      record: vi.fn(),
    } as unknown as MailEngagementService);
  };

  beforeEach(() => {
    service = make();
  });

  describe('verifySignature', () => {
    it('正确签名通过', () => {
      const body = '{"type":"email.bounced"}';
      const h = signedHeaders('msg_1', String(Math.floor(Date.now() / 1000)), body);
      expect(service.verifySignature(body, h)).toBe(true);
    });

    it('rejects stale or future signed requests and unknown signature versions', () => {
      const now = Math.floor(Date.now() / 1000);
      for (const ts of [now - 301, now + 301])
        expect(service.verifySignature('{}', signedHeaders('id', String(ts), '{}'))).toBe(false);
      const headers = signedHeaders('id', String(now), '{}');
      headers['svix-signature'] = headers['svix-signature'].replace('v1,', 'v2,');
      expect(service.verifySignature('{}', headers)).toBe(false);
    });

    it('篡改 body → 验签失败', () => {
      const h = signedHeaders(
        'msg_1',
        String(Math.floor(Date.now() / 1000)),
        '{"type":"email.bounced"}',
      );
      expect(service.verifySignature('{"type":"email.delivered"}', h)).toBe(false);
    });

    it('缺 svix 头 → 失败', () => {
      expect(service.verifySignature('{}', {})).toBe(false);
    });

    it('未配置 secret → 拒绝', () => {
      const s = make('');
      const body = '{}';
      expect(s.verifySignature(body, signedHeaders('a', 'b', body))).toBe(false);
    });
  });

  describe('handleEvent', () => {
    it('硬退信 → 抑制邮箱', async () => {
      await service.handleEvent({
        type: 'email.bounced',
        data: { to: ['BAD@x.com'], bounce: { type: 'Permanent' } },
      });
      expect(suppress).toHaveBeenCalledWith(['bad@x.com'], 'hard_bounce');
    });

    it('投诉 → 抑制邮箱 (complained)', async () => {
      await service.handleEvent({ type: 'email.complained', data: { to: 'spam@x.com' } });
      expect(suppress).toHaveBeenCalledWith(['spam@x.com'], 'complained');
    });

    it('软退信 → 不抑制', async () => {
      await service.handleEvent({
        type: 'email.bounced',
        data: { to: ['full@x.com'], bounce: { type: 'Transient' } },
      });
      expect(suppress).not.toHaveBeenCalled();
    });

    it('其它事件（delivered）→ 不处理', async () => {
      await service.handleEvent({ type: 'email.delivered', data: { to: ['ok@x.com'] } });
      expect(suppress).not.toHaveBeenCalled();
    });
  });
});
