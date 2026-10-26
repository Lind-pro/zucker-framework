interface Attempt {
  key: string;
  storageKey: string;
  existing: boolean;
  persisted: boolean;
}
const memory = new Map<string, string>();
const storage = () => {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
};
const digest = async (value: BufferSource) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
export async function fileFingerprint(file: File) {
  return digest(
    new TextEncoder().encode(
      JSON.stringify([file.name, file.size, await digest(await file.arrayBuffer())]),
    ),
  );
}
export async function importFingerprint(url: string, fileName: string) {
  return digest(new TextEncoder().encode(JSON.stringify([url, fileName])));
}
/** Store only a request hash and random key; file contents, names and source URLs never enter browser storage. */
export function fileAttempt(
  owner: string,
  kind: 'upload' | 'import',
  fingerprint: string,
): Attempt {
  const storageKey = `zucker.files.${kind}:${JSON.stringify([owner, fingerprint])}`;
  let key = memory.get(storageKey),
    persisted = false;
  try {
    const saved = storage()?.getItem(storageKey);
    if (saved && /^[A-Za-z0-9_-]{16,128}$/.test(saved)) {
      key = saved;
      persisted = true;
    }
  } catch {
    /* Use the in-memory attempt. */
  }
  const existing = Boolean(key);
  key ??= crypto.randomUUID();
  memory.set(storageKey, key);
  try {
    storage()?.setItem(storageKey, key);
    persisted = storage()?.getItem(storageKey) === key;
  } catch {
    /* Current-page retries keep the key. */
  }
  return { key, storageKey, existing, persisted };
}
export function clearFileAttempt(attempt: Attempt) {
  memory.delete(attempt.storageKey);
  try {
    if (storage()?.getItem(attempt.storageKey) === attempt.key)
      storage()?.removeItem(attempt.storageKey);
  } catch {
    /* No storage access. */
  }
}
