import { storageGet, storageSet, storageRemove } from './util';
import type { LicensingConfig } from './types';

export interface Entitlement {
  plan: string;
  expiresAt: string;
}

export interface Licensing {
  activate(code: string): Promise<unknown>;
  getEntitlement(): Promise<Entitlement | null>;
  isPro(): Promise<boolean>;
  clear(): Promise<void>;
  purchaseUrl: string;
}

const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

// 服务端 TransformInterceptor 包装 { status, message, result }
function unwrap(payload: unknown): Record<string, unknown> {
  const obj = payload as Record<string, unknown> | null;
  return obj && typeof obj === 'object' && 'result' in obj
    ? (obj.result as Record<string, unknown>)
    : ((obj || {}) as Record<string, unknown>);
}

export function createLicensing(product: string, brand: string, config: LicensingConfig): Licensing {
  const TOKEN_KEY = `${product}_license_token`;
  const ENTITLEMENT_KEY = `${product}_entitlement`;
  const DEVICE_KEY = `${product}_device_id`;

  async function getDeviceId(): Promise<string> {
    const data = await storageGet(DEVICE_KEY);
    if (data[DEVICE_KEY]) {
      return data[DEVICE_KEY] as string;
    }
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    await storageSet({ [DEVICE_KEY]: id });
    return id;
  }

  async function activate(code: string): Promise<unknown> {
    const deviceId = await getDeviceId();
    let response: Response;
    try {
      const platform =
        (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform || 'Chrome';
      response = await fetch(`${config.apiBase}/extension/licenses/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, ''),
          deviceId,
          deviceName: `${brand} · ${platform}`,
        }),
      });
    } catch {
      throw new Error('License service unreachable. Check your connection and retry.');
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 403) {
        throw new Error('Invalid code, or its device limit is reached.');
      }
      throw new Error('Activation failed. Please retry later.');
    }
    const data = unwrap(payload);
    await storageSet({
      [TOKEN_KEY]: (data.token as string) || '',
      [ENTITLEMENT_KEY]: { ...((data.entitlement as object) || {}), checkedAt: Date.now() },
    });
    return data.entitlement;
  }

  function normalize(value: unknown): Entitlement | null {
    const v = value as { plan?: string; expiresAt?: string } | null;
    if (!v) {
      return null;
    }
    const expired = v.expiresAt && new Date(v.expiresAt).getTime() <= Date.now();
    return expired ? null : { plan: v.plan || 'pro', expiresAt: v.expiresAt || '' };
  }

  async function getEntitlement(): Promise<Entitlement | null> {
    const data = await storageGet([TOKEN_KEY, ENTITLEMENT_KEY]);
    const token = data[TOKEN_KEY] as string | undefined;
    const cached = data[ENTITLEMENT_KEY] as { checkedAt?: number } | undefined;
    if (!token) {
      return null;
    }

    if (cached?.checkedAt && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
      return normalize(cached);
    }

    let response: Response;
    try {
      response = await fetch(`${config.apiBase}/extension/licenses/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      return cached ? normalize(cached) : null;
    }
    if (!response.ok) {
      // 仅明确拒绝才清除授权；服务端故障沿用缓存
      if (response.status === 401 || response.status === 403) {
        await clear();
        return null;
      }
      return cached ? normalize(cached) : null;
    }
    const payload = await response.json().catch(() => ({}));
    const entitlement = unwrap(payload)?.entitlement;
    await storageSet({
      [ENTITLEMENT_KEY]: { ...((entitlement as object) || {}), checkedAt: Date.now() },
    });
    return normalize(entitlement);
  }

  async function isPro(): Promise<boolean> {
    return Boolean(await getEntitlement());
  }

  async function clear(): Promise<void> {
    await storageRemove([TOKEN_KEY, ENTITLEMENT_KEY]);
  }

  return { activate, getEntitlement, isPro, clear, purchaseUrl: config.purchaseUrl };
}
