/** Validation shared by the sequence implementations; ordinary cache values remain unrestricted. */
export function assertSequenceValue(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError('Cache sequence must be a non-negative safe integer');
  }
}

export function assertSequenceArguments(minimum: number, ttlMs: number): void {
  assertSequenceValue(minimum);
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw new RangeError('Cache sequence ttlMs must be a positive safe integer');
  }
}
