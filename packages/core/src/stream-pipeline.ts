/**
 * AsyncGenerator 流式管道 — 对标 Claude Code queryModelWithStreaming 的 generator 组合模式
 *
 * 提供可组合的异步流式处理工具，用于大数据导出、SSE 推送、AI 流式响应等场景。
 *
 * 用法:
 * ```ts
 * // 分批流式读取
 * const stream = streamQuery(service, { filter: { status: 'active' } }, 100);
 *
 * // 转换 + 缓冲
 * const pipeline = pipe(
 *   stream,
 *   mapStream(batch => batch.map(formatForCsv)),
 *   bufferStream(1000),
 * );
 *
 * for await (const chunk of pipeline) {
 *   await writeToFile(chunk);
 * }
 * ```
 */

/**
 * 将普通数组转为 AsyncGenerator
 */
export async function* fromArray<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

/**
 * 将多个 AsyncGenerator 串联
 */
export async function* concat<T>(...sources: AsyncGenerator<T>[]): AsyncGenerator<T> {
  for (const source of sources) {
    yield* source;
  }
}

/**
 * 对流中每个元素进行转换
 */
export async function* mapStream<T, U>(
  source: AsyncIterable<T>,
  fn: (item: T, index: number) => U | Promise<U>,
): AsyncGenerator<U> {
  let index = 0;
  for await (const item of source) {
    yield await fn(item, index++);
  }
}

/**
 * 过滤流中的元素
 */
export async function* filterStream<T>(
  source: AsyncIterable<T>,
  predicate: (item: T) => boolean | Promise<boolean>,
): AsyncGenerator<T> {
  for await (const item of source) {
    if (await predicate(item)) yield item;
  }
}

/**
 * 对流做 flatMap（每个输入元素产出 0~N 个输出元素）
 */
export async function* flatMapStream<T, U>(
  source: AsyncIterable<T>,
  fn: (item: T) => AsyncIterable<U> | Iterable<U>,
): AsyncGenerator<U> {
  for await (const item of source) {
    yield* fn(item) as AsyncGenerator<U>;
  }
}

/**
 * 将流元素按固定大小分批
 */
export async function* batchStream<T>(
  source: AsyncIterable<T>,
  batchSize: number,
): AsyncGenerator<T[]> {
  let batch: T[] = [];
  for await (const item of source) {
    batch.push(item);
    if (batch.length >= batchSize) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length > 0) yield batch;
}

/**
 * 限制流的元素数量
 */
export async function* takeStream<T>(
  source: AsyncIterable<T>,
  limit: number,
): AsyncGenerator<T> {
  let count = 0;
  for await (const item of source) {
    if (count >= limit) break;
    yield item;
    count++;
  }
}

/**
 * 跳过流的前 N 个元素
 */
export async function* skipStream<T>(
  source: AsyncIterable<T>,
  count: number,
): AsyncGenerator<T> {
  let skipped = 0;
  for await (const item of source) {
    if (skipped < count) {
      skipped++;
      continue;
    }
    yield item;
  }
}

/**
 * 对流做副作用操作（不修改元素）
 */
export async function* tapStream<T>(
  source: AsyncIterable<T>,
  fn: (item: T) => void | Promise<void>,
): AsyncGenerator<T> {
  for await (const item of source) {
    await fn(item);
    yield item;
  }
}

/**
 * 收集流中所有元素到数组
 */
export async function collectStream<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of source) {
    result.push(item);
  }
  return result;
}

/**
 * 对流做 reduce
 */
export async function reduceStream<T, U>(
  source: AsyncIterable<T>,
  reducer: (acc: U, item: T) => U | Promise<U>,
  initial: U,
): Promise<U> {
  let acc = initial;
  for await (const item of source) {
    acc = await reducer(acc, item);
  }
  return acc;
}

/**
 * 计数流中元素
 */
export async function countStream<T>(source: AsyncIterable<T>): Promise<number> {
  let count = 0;
  for await (const _ of source) {
    count++;
  }
  return count;
}
