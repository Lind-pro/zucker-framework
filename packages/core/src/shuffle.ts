/** Fisher–Yates shuffle returning a copy; rng must return a finite value in [0, 1). */
export function shuffle<T>(items: readonly T[], rng: () => number = Math.random): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const value = rng();
    if (!Number.isFinite(value) || value < 0 || value >= 1) {
      throw new RangeError('rng must return a number in [0, 1)');
    }
    const j = Math.floor(value * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
