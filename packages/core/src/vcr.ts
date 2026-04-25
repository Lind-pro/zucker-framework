import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

/**
 * VCR 测试固件 — 对标 Claude Code vcr.ts
 *
 * 录制 HTTP/API 响应并 dehydrate 可变部分，使固件可跨机器复用。
 *
 * 用法:
 * ```ts
 * // 测试中使用
 * const result = await withVcrFixture(
 *   'user-service-get',
 *   { userId: '123' },
 *   () => userService.findOne('123'),
 * );
 *
 * // 首次运行：执行实际调用，录制结果到 fixtures/user-service-get-<hash>.json
 * // 后续运行：直接从固件读取，跳过实际调用
 * ```
 */

export interface VcrOptions {
  /** 固件目录 */
  fixtureDir?: string;
  /** 是否启用录制模式（默认从 VCR_RECORD 环境变量读取） */
  record?: boolean;
  /** 自定义 dehydrator（替换可变值） */
  dehydrators?: Dehydrator[];
}

export interface Dehydrator {
  name: string;
  pattern: RegExp;
  replacement: string;
}

const DEFAULT_DEHYDRATORS: Dehydrator[] = [
  { name: 'timestamp', pattern: /"\d{13,}"/g, replacement: '"[TIMESTAMP]"' },
  { name: 'uuid', pattern: /"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/gi, replacement: '"[UUID]"' },
  { name: 'iso_date', pattern: /"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^"]*"/g, replacement: '"[ISO_DATE]"' },
  { name: 'duration', pattern: /"duration":\s*\d+/g, replacement: '"duration": "[DURATION]"' },
];

/**
 * 通过 VCR 固件执行操作
 *
 * @param name 固件名称
 * @param input 输入参数（用于生成哈希）
 * @param fn 实际操作函数
 * @param options VCR 配置
 */
export async function withVcrFixture<T>(
  name: string,
  input: unknown,
  fn: () => Promise<T>,
  options: VcrOptions = {},
): Promise<T> {
  const fixtureDir = options.fixtureDir ?? join(process.cwd(), '__fixtures__');
  const shouldRecord = options.record ?? process.env.VCR_RECORD === '1';

  const hash = createHash('sha1')
    .update(JSON.stringify(input))
    .digest('hex')
    .slice(0, 12);
  const fixturePath = join(fixtureDir, `${name}-${hash}.json`);

  // 尝试读取已有固件
  if (existsSync(fixturePath)) {
    const content = readFileSync(fixturePath, 'utf-8');
    return JSON.parse(content) as T;
  }

  // 固件不存在
  if (!shouldRecord) {
    // 非录制模式：直接执行（不录制）
    return fn();
  }

  // 录制模式：执行并保存
  const result = await fn();

  // Dehydrate 可变值
  const dehydrators = [...DEFAULT_DEHYDRATORS, ...(options.dehydrators ?? [])];
  let serialized = JSON.stringify(result, null, 2);
  for (const d of dehydrators) {
    serialized = serialized.replace(d.pattern, d.replacement);
  }

  // 写入固件
  const dir = dirname(fixturePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(fixturePath, serialized, 'utf-8');

  return result;
}

/**
 * 生成固件路径（不执行任何操作）
 */
export function getFixturePath(name: string, input: unknown, fixtureDir?: string): string {
  const dir = fixtureDir ?? join(process.cwd(), '__fixtures__');
  const hash = createHash('sha1')
    .update(JSON.stringify(input))
    .digest('hex')
    .slice(0, 12);
  return join(dir, `${name}-${hash}.json`);
}
