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
 * const results = await pLimit(records, 3, async (record) => {
 *   return await processRecord(record);
 * });
 */
export async function pLimit<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  options: { rejectOnError?: boolean; /** Stop scheduling and await active workers before rejecting. */ drainOnError?: boolean } = {},
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('concurrency must be a positive integer');
  }
  const results: R[] = new Array(items.length);
  let index = 0;
  let failed = false;
  let firstError: unknown;

  async function worker(): Promise<void> {
    while (index < items.length && !failed) {
      const current = index++;
      try {
        results[current] = await fn(items[current], current);
      } catch (error) {
        if (options.rejectOnError || options.drainOnError) {
          if (!failed) firstError = error;
          failed = true;
          if (!options.drainOnError) throw error;
          return;
        }
        results[current] = error as R;
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  if (failed) throw firstError;
  return results;
}
