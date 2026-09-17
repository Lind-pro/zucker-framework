import { describe, expect, it } from 'vitest';
import { checkPaymentAdapterContract, type AdapterProbe } from './contract-suite';
import { createFakeAdapter, type FakeAdapterOptions } from './fake-adapter';

const invalidWebhook = { rawBody: '{}', headers: { 'x-fake-signature': 'forged' } };

function probeFor(options: FakeAdapterOptions): AdapterProbe {
  return {
    create: () => createFakeAdapter(options),
    supportedCurrency: 'USD',
    unsupportedCurrency: options.supportedCurrencies ? 'CNY' : null,
    invalidWebhook,
  };
}

describe('渠道适配器契约套件', () => {
  it('合规适配器全部条目通过', async () => {
    const checks = await checkPaymentAdapterContract(
      probeFor({ supportedCurrencies: ['USD', 'EUR'] }),
    );
    expect(checks.filter((check) => !check.ok)).toEqual([]);
  });

  /*
   * 这组用例测的是**套件本身**：一套永远绿灯的断言证明不了任何事。
   * 每种故意的违约都必须被对应的那一条抓到，新增检查项时同步补一个缺陷变体。
   */
  it.each([
    ['retrieveCaptures', 'retrieve 必须只读'],
    ['ignoreIdempotency', '相同幂等键不得产生第二笔支付'],
    ['acceptsBadSignature', '验签失败必须抛错而非返回未知事件'],
    ['mangleAmount', '金额必须以十进制字符串原样透传'],
    ['guessesPendingAsFailed', '在途支付不得被判为 failed'],
  ] as const)('缺陷 %s 必须被「%s」抓到', async (defect, expectedCheck) => {
    const checks = await checkPaymentAdapterContract(
      probeFor({ defects: { [defect]: true } }),
    );
    const failed = checks.filter((check) => !check.ok).map((check) => check.name);
    expect(failed).toContain(expectedCheck);
  });

  it('检出是定向的，不会连带误报无关条目', async () => {
    const checks = await checkPaymentAdapterContract(
      probeFor({ defects: { retrieveCaptures: true } }),
    );
    const failed = checks.filter((check) => !check.ok).map((check) => check.name);
    expect(failed).not.toContain('相同幂等键不得产生第二笔支付');
    expect(failed).not.toContain('验签失败必须抛错而非返回未知事件');
  });
});
