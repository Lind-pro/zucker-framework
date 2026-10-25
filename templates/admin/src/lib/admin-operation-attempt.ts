interface Attempt {
  key: string;
  fingerprint: string;
  persisted: boolean;
  existing: boolean;
}
type OperationKind = 'credit-grant' | 'refund';
const pending = new Map<string, Attempt>();
async function bodyFingerprint(body: unknown): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(body))),
    ),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}
function readAttempt(prefix: string, fingerprint: string): Attempt | null {
  const storageKey = `${prefix}:${fingerprint}`;
  let cached = pending.get(storageKey);
  try {
    const value: unknown = JSON.parse(
      sessionStorage.getItem(storageKey) ?? sessionStorage.getItem(prefix) ?? 'null',
    );
    if (
      value &&
      typeof value === 'object' &&
      'fingerprint' in value &&
      value.fingerprint === fingerprint &&
      'key' in value &&
      typeof value.key === 'string' &&
      /^[0-9a-f-]{36}$/.test(value.key)
    )
      cached = { fingerprint, key: value.key, persisted: true, existing: true };
  } catch {
    /* Memory retains a stable retry when storage is unavailable. */
  }
  return cached ? { ...cached, existing: true } : null;
}
/** Inspect a pending intent without creating a new nonce or persisting form text. */
export async function findAdminOperationAttempt(
  kind: OperationKind,
  actorId: string,
  body: unknown,
): Promise<Attempt | null> {
  return readAttempt(`zucker:admin-${kind}:${actorId}`, await bodyFingerprint(body));
}
/** Distinct pending intents keep distinct retry keys; browser storage contains hashes, never form text. */
export async function adminOperationAttempt(
  kind: OperationKind,
  actorId: string,
  body: unknown,
): Promise<Attempt> {
  const fingerprint = await bodyFingerprint(body),
    prefix = `zucker:admin-${kind}:${actorId}`,
    storageKey = `${prefix}:${fingerprint}`;
  const cached = readAttempt(prefix, fingerprint);
  const result: Attempt = {
    fingerprint,
    key: cached?.key ?? crypto.randomUUID(),
    persisted: false,
    existing: Boolean(cached),
  };
  try {
    sessionStorage.setItem(storageKey, JSON.stringify({ fingerprint, key: result.key }));
    result.persisted = true;
  } catch {
    /* Report lack of refresh persistence to the caller. */
  }
  pending.set(storageKey, result);
  return result;
}
export function clearAdminOperationAttempt(
  kind: OperationKind,
  actorId: string,
  key: string,
): void {
  const prefix = `zucker:admin-${kind}:${actorId}`;
  for (const [storageKey, attempt] of pending)
    if ((storageKey === prefix || storageKey.startsWith(`${prefix}:`)) && attempt.key === key)
      pending.delete(storageKey);
  try {
    const keys = Array.from({ length: sessionStorage.length }, (_, index) =>
      sessionStorage.key(index),
    ).filter(
      (value): value is string =>
        value !== null && (value === prefix || value.startsWith(`${prefix}:`)),
    );
    for (const storageKey of keys) {
      const stored = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as {
        key?: string;
      } | null;
      if (stored?.key === key) sessionStorage.removeItem(storageKey);
    }
  } catch {
    /* A missing persistent slot cannot prevent clearing the acknowledged in-memory attempt. */
  }
}
