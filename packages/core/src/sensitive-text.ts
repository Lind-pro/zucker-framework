/**
 * PII / 敏感信息脱敏工具
 *
 * 用于日志输出与降级权限下的接口响应，避免邮箱明文、SMTP 内部 IP、
 * token/密码等泄漏给运维或低权限管理员。
 */

/** 邮箱脱敏：u***@example.com（保留首字符与域名） */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return '(empty)';
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const head = local.slice(0, 1);
  return `${head}***@${domain}`;
}

/** 逗号分隔的多收件人逐个脱敏 */
export function maskRecipients(recipient: string | null | undefined): string {
  if (!recipient) return '(empty)';
  return recipient
    .split(',')
    .map((r) => maskEmail(r.trim()))
    .join(', ');
}

const IPV4 = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
// 简化 IPv6：≥3 段 hex:（避免误伤 HH:MM:SS 这类只有 2 个冒号的时间戳）
const IPV6 = /\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{0,4}\b/gi;
const SECRET_KV =
  /\b(password|passwd|token|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret|api[_-]?key|authorization|bearer|jwt|cookie|set-cookie|credential)\b\s*[=:]?\s*\S+/gi;

/**
 * 清洗错误信息中的敏感片段（内部 IP、token、密码、JWT、cookie 等），并截断长度。
 * 用于把 provider 原始错误回传前端前的处理。
 * 注意：黑名单式清洗非完备，长期应考虑白名单错误码。
 */
export function scrubSensitive(text: string | null | undefined, maxLen = 200): string | null {
  if (!text) return text ?? null;
  let out = text.replace(IPV4, '[ip]').replace(IPV6, '[ip]').replace(SECRET_KV, '$1=[redacted]');
  if (out.length > maxLen) out = out.slice(0, maxLen) + '…';
  return out;
}
