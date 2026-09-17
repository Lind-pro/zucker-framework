import type { PaymentProviderAdapter, WebhookRequest } from "./payment-contract";
import { adapterSupportsCurrency } from "./payment-contract";

/**
 * 渠道适配器契约套件。
 *
 * 多渠道抽象的价值不在接口长什么样，而在于**所有渠道遵守同一组安全性质**。
 * 每接一个渠道都要跑这套；它抓的是那些只在生产环境、只在特定时序下才暴露的错误。
 *
 * 刻意不依赖任何测试框架：返回结构化结果，既能在 vitest/jest 里包一层，
 * 也能被 node --test 或 CI 脚本直接调用。
 */

export interface ContractCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface AdapterProbe {
  /** 每次返回全新的适配器实例，以及它对供应商发起过的**写操作**记录 */
  create(): { adapter: PaymentProviderAdapter; mutatingCalls: () => string[] };
  /** 该渠道支持的一个币种 */
  supportedCurrency: string;
  /** 该渠道不支持的一个币种；未声明限制时传 null */
  unsupportedCurrency: string | null;
  /** 一个签名无效的 webhook 请求 */
  invalidWebhook: WebhookRequest;
  /** 写操作端点名中代表"扣款"的片段，用于检测只读违规 */
  captureCallNames?: readonly string[];
}

const MUTATING = ["capture", "refund", "cancel"];

export async function checkPaymentAdapterContract(
  probe: AdapterProbe,
): Promise<ContractCheck[]> {
  const checks: ContractCheck[] = [];
  const captureNames = probe.captureCallNames ?? MUTATING;

  const run = async (name: string, fn: () => Promise<string | undefined>) => {
    try {
      const detail = await fn();
      checks.push({ name, ok: detail === undefined, detail });
    } catch (error) {
      checks.push({
        name,
        ok: false,
        detail: `抛出异常：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };

  /*
   * 对账会反复调用 retrieve。一旦它顺手扣了款，就会出现"用户没付钱却被扣"
   * 或"取消的订单被对账任务扣款"。这是这类系统最贵的一类 bug，放在第一条。
   */
  await run("retrieve 必须只读", async () => {
    const { adapter, mutatingCalls } = probe.create();
    const created = await adapter.createPayment(input(probe.supportedCurrency));
    const before = mutatingCalls().filter((c) => captureNames.includes(c)).length;
    await adapter.retrieve(created.providerRef);
    const after = mutatingCalls().filter((c) => captureNames.includes(c)).length;
    return after > before
      ? `retrieve 触发了写操作：${mutatingCalls().join(", ")}`
      : undefined;
  });

  /* 网络抖动、用户连点、前端重试都会重放同一次下单；不幂等就是重复扣款 */
  await run("相同幂等键不得产生第二笔支付", async () => {
    const { adapter } = probe.create();
    const key = "contract-idempotency-key";
    const first = await adapter.createPayment(input(probe.supportedCurrency, key));
    const second = await adapter.createPayment(input(probe.supportedCurrency, key));
    return first.providerRef === second.providerRef
      ? undefined
      : `产生了两笔：${first.providerRef} 与 ${second.providerRef}`;
  });

  /* 验签失败必须抛错。返回一个"未知事件"会让调用方把伪造请求当正常回调处理 */
  await run("验签失败必须抛错而非返回未知事件", async () => {
    const { adapter } = probe.create();
    try {
      const observation = await adapter.parseWebhook(probe.invalidWebhook);
      return `未抛错，返回了 ${JSON.stringify(observation.type)}`;
    } catch {
      return undefined;
    }
  });

  /* 金额必须原样透传。一旦进过 float，29.00 会变成 29，0.1+0.2 会变成 0.30000000000000004 */
  await run("金额必须以十进制字符串原样透传", async () => {
    const { adapter } = probe.create();
    const amount = "29.00";
    const created = await adapter.createPayment({
      ...input(probe.supportedCurrency),
      money: { amount, currency: probe.supportedCurrency },
    });
    return created.money.amount === amount
      ? undefined
      : `期望 "${amount}"，实际 ${JSON.stringify(created.money.amount)}`;
  });

  /* 未完成的支付不能被猜成 failed——"查不到"和"确定没付"是两件事 */
  await run("在途支付不得被判为 failed", async () => {
    const { adapter } = probe.create();
    const created = await adapter.createPayment(input(probe.supportedCurrency));
    const retrieved = await adapter.retrieve(created.providerRef);
    return retrieved.state === "failed"
      ? "刚创建、用户尚未操作的支付被判为 failed"
      : undefined;
  });

  await run("nextAction 必须是契约内的 kind", async () => {
    const { adapter } = probe.create();
    const created = await adapter.createPayment(input(probe.supportedCurrency));
    const known = ["redirect", "qrcode", "form_post", "sdk_params", "none"];
    return known.includes(created.nextAction.kind)
      ? undefined
      : `未知 kind：${created.nextAction.kind}`;
  });

  await run("币种能力声明与实际一致", async () => {
    const { adapter } = probe.create();
    if (!adapter.supportedCurrencies) return undefined;
    if (!adapterSupportsCurrency(adapter, probe.supportedCurrency)) {
      return `声明不支持 ${probe.supportedCurrency}，但探针称其支持`;
    }
    if (
      probe.unsupportedCurrency &&
      adapterSupportsCurrency(adapter, probe.unsupportedCurrency)
    ) {
      return `声明支持 ${probe.unsupportedCurrency}，但探针称其不支持`;
    }
    return undefined;
  });

  return checks;
}

function input(currency: string, idempotencyKey = "contract-default-key") {
  return {
    reference: "contract-order",
    money: { amount: "10.00", currency },
    idempotencyKey,
  };
}
