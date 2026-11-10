/**
 * 十进制金额字符串与供应商最小单位之间的转换。
 *
 * 契约对外一律用十进制字符串（见 Money），但 Stripe 等渠道的 API 收最小单位整数。
 * 转换只发生在适配器边界。用字符串补位而不是 `Math.round(x * 100)`，真正的收益有两点
 * （不是"浮点一定算错"——对两位小数的常规金额，乘 100 再取整其实是可靠的）：
 *   1. **精度超限会报错而不是静默取整**。`Math.round(1.005 * 100)` 得到 100，
 *      悄悄吞掉半分钱；这里直接拒绝，让调用方去面对它本就不该产生的金额。
 *   2. **零小数位币种不会被乘以 100**。JPY 的 500 就是 500，按两位小数处理会放大 100 倍。
 */

/** 无小数位的币种（Stripe 口径）：金额即最小单位本身 */
const ZERO_DECIMAL = new Set([
  "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA",
  "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);

/** 三位小数币种（ISO 4217，Stripe 亦按 3 位最小单位收取） */
const THREE_DECIMAL = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);

/**
 * Stripe API 的特例：这些币种对外是整数金额，但 API 仍按两位小数传（必须是 100 的倍数）。
 * 见 Stripe "Special cases" 文档。
 */
const STRIPE_TWO_DECIMAL_WHOLE_UNIT = new Set(["ISK", "UGX"]);

function currencyCode(currency: string): string {
  const code = currency.trim().toUpperCase();
  // A malformed code must not silently fall back to two decimals.
  if (!/^[A-Z]{3}$/.test(code)) throw new Error(`币种代码非法：${currency}`);
  return code;
}

export function currencyExponent(currency: string): number {
  const code = currencyCode(currency);
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return 2;
}

/**
 * 十进制金额 → Stripe API 最小单位。处理 Stripe 与 ISO 指数不一致的币种：
 * - ISK / UGX：API 用两位小数，但只接受整数金额；
 * - BHD/JOD/KWD/OMR/TND：三位小数，Stripe 要求最后一位为 0。
 */
export function toStripeMinorUnits(amount: string, currency: string): number {
  const code = currencyCode(currency);
  if (STRIPE_TWO_DECIMAL_WHOLE_UNIT.has(code)) {
    toMinorUnits(amount, "JPY"); // whole units only
    return toMinorUnits(amount, "USD");
  }
  const value = toMinorUnits(amount, code);
  if (THREE_DECIMAL.has(code) && value % 10 !== 0) {
    throw new Error(`Stripe 要求 ${code} 金额的最后一位小数为 0，收到 ${amount}`);
  }
  return value;
}

/** Stripe API 最小单位 → 十进制金额（ISK/UGX 按两位小数还原）。 */
export function fromStripeMinorUnits(value: number, currency: string): string {
  const code = currencyCode(currency);
  return fromMinorUnits(value, STRIPE_TWO_DECIMAL_WHOLE_UNIT.has(code) ? "USD" : code);
}

/** "29.00" + USD → 2900；"500" + JPY → 500 */
export function toMinorUnits(amount: string, currency: string): number {
  const exponent = currencyExponent(currency);
  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(amount.trim());
  if (!match) throw new Error(`金额格式非法：${amount}`);
  const [, sign, whole, fraction = ""] = match;
  if (fraction.length > exponent && /[^0]/.test(fraction.slice(exponent))) {
    throw new Error(`${currency} 最多支持 ${exponent} 位小数，收到 ${amount}`);
  }
  const padded = (fraction + "0".repeat(exponent)).slice(0, exponent);
  const value = Number(`${whole}${padded}`);
  if (!Number.isSafeInteger(value)) throw new Error(`金额超出安全整数范围：${amount}`);
  return sign === "-" ? -value : value;
}

/** 2900 + USD → "29.00"；500 + JPY → "500" */
export function fromMinorUnits(value: number, currency: string): string {
  if (!Number.isInteger(value)) throw new Error(`最小单位必须是整数：${value}`);
  const exponent = currencyExponent(currency);
  const sign = value < 0 ? "-" : "";
  const digits = String(Math.abs(value)).padStart(exponent + 1, "0");
  if (exponent === 0) return `${sign}${digits}`;
  return `${sign}${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
}
