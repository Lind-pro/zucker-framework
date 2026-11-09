/**
 * Idempotency keys for administrative commands whose result may be unknown (lost response,
 * refresh during submit). Each distinct pending intent keeps its own key; retrying the same
 * intent, including after a page refresh, reuses it. Browser storage holds only a hash of the
 * request body and the random key, never form contents.
 *
 * The key is an idempotency token, not a secret, and the fingerprint only matches an intent to its
 * pending key. Both therefore work outside a secure context (plain-HTTP intranet admin, where
 * `crypto.subtle` and `crypto.randomUUID` are unavailable): the fingerprint falls back to a
 * deterministic non-cryptographic hash and the key to `crypto.getRandomValues`.
 */
export interface OperationAttempt {
  key: string;
  fingerprint: string;
  /** False when sessionStorage is unavailable: the key survives only in this document. */
  persisted: boolean;
  /** True when this intent already had a pending key. */
  existing: boolean;
}

const pending = new Map<string, OperationAttempt>();

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/** 128-bit non-cryptographic hash (four seeded FNV-1a lanes); deterministic across reloads. */
function fallbackHash(text: string): string {
  const lanes = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b];
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    for (let lane = 0; lane < lanes.length; lane++)
      lanes[lane] = Math.imul(lanes[lane] ^ (code + lane * 0x9e37), 0x01000193 + lane * 2) >>> 0;
  }
  return `fnv-${lanes.map((value) => value.toString(16).padStart(8, '0')).join('')}`;
}

async function bodyFingerprint(body: unknown): Promise<string> {
  const text = JSON.stringify(body);
  const subtle = typeof crypto !== 'undefined' ? crypto.subtle : undefined;
  if (subtle && typeof subtle.digest === 'function') {
    try {
      return hex(new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(text))));
    } catch {
      /* Fall through: some browsers expose subtle but reject it outside a secure context. */
    }
  }
  return fallbackHash(text);
}

/** RFC 4122 v4 UUID, using `randomUUID` when available and `getRandomValues` otherwise. */
function newKey(): string {
  const source = typeof crypto !== 'undefined' ? crypto : undefined;
  if (source && typeof source.randomUUID === 'function') {
    try {
      return source.randomUUID();
    } catch {
      /* randomUUID requires a secure context in some browsers. */
    }
  }
  const bytes = new Uint8Array(16);
  if (source && typeof source.getRandomValues === 'function') source.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = hex(bytes);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

const prefixFor = (kind: string, actorId: string) => `zucker:admin-${kind}:${actorId}`;

function readAttempt(prefix: string, fingerprint: string): OperationAttempt | null {
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

/** Inspect a pending intent without creating a new key or persisting anything. */
export async function findOperationAttempt(
  kind: string,
  actorId: string,
  body: unknown,
): Promise<OperationAttempt | null> {
  return readAttempt(prefixFor(kind, actorId), await bodyFingerprint(body));
}

/** Return the key for this intent, creating and remembering one when none is pending. */
export async function operationAttempt(
  kind: string,
  actorId: string,
  body: unknown,
): Promise<OperationAttempt> {
  const fingerprint = await bodyFingerprint(body),
    prefix = prefixFor(kind, actorId),
    storageKey = `${prefix}:${fingerprint}`;
  const cached = readAttempt(prefix, fingerprint);
  const result: OperationAttempt = {
    fingerprint,
    key: cached?.key ?? newKey(),
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

/** Forget an acknowledged key so the next identical intent is a new operation. */
export function clearOperationAttempt(kind: string, actorId: string, key: string): void {
  const prefix = prefixFor(kind, actorId);
  for (const [storageKey, attempt] of pending)
    if ((storageKey === prefix || storageKey.startsWith(`${prefix}:`)) && attempt.key === key)
      pending.delete(storageKey);
  try {
    const keys = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index)).filter(
      (value): value is string => value !== null && (value === prefix || value.startsWith(`${prefix}:`)),
    );
    for (const storageKey of keys) {
      const stored = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as { key?: string } | null;
      if (stored?.key === key) sessionStorage.removeItem(storageKey);
    }
  } catch {
    /* A missing persistent slot cannot prevent clearing the acknowledged in-memory attempt. */
  }
}
