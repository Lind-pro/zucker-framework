export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function storageGet(keys: string | string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

export function storageSet(value: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => chrome.storage.local.set(value, () => resolve()));
}

export function storageRemove(keys: string | string[]): Promise<void> {
  return new Promise((resolve) => chrome.storage.local.remove(keys, () => resolve()));
}
