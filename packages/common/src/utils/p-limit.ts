/**
 * Concurrency-limited async map.
 * Processes an array of items concurrently with at most `concurrency` tasks running at once.
 *
 * @param items - Array of items to process
 * @param concurrency - Maximum concurrent operations
 * @param fn - Async function to apply to each item
 * @returns Promise resolving to array of results in input order
 *
 * @example
 * const results = await pLimit(patents, 3, async (patent) => {
 *   return await generateEmbedding(patent);
 * });
 */
export async function pLimit<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;

  async function worker(): Promise<void> {
    while (index < items.length) {
      const current = index++;
      try {
        results[current] = await fn(items[current], current);
      } catch (error) {
        results[current] = error as R;
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
