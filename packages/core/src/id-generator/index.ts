import { createId } from '@paralleldrive/cuid2';
import { randomUUID, randomBytes, createHash } from 'crypto';

/**
 * Generate a collision-resistant unique ID using CUID2.
 * This is the default ID generation strategy for entities.
 * @returns A CUID2 string identifier
 */
export function generateId(): string {
  return createId();
}

/**
 * Generate a standard UUID v4 identifier.
 * @returns A UUID v4 string (e.g., '550e8400-e29b-41d4-a716-446655440000')
 */
export function generateUUID(): string {
  return randomUUID();
}

/**
 * 雪花算法 ID 生成器（改进版）
 *
 * - 增加时钟回拨检测和保护
 * - 增加序列号溢出时等待下一毫秒（tilNextMillis）
 * - 支持配置 workerId 和 dataCenterId
 * - 使用 synchronized 等价：单线程 + 互斥保证
 */
class SnowflakeIdGeneratorImpl {
  private readonly workerId: bigint;
  private readonly dataCenterId: bigint;

  private sequence = 0n;
  private lastTimestamp = -1n;

  // 配置参数
  private readonly twepoch = 1288834974657n; // Snowflake epoch（2010-11-04T01:42:54.657Z）
  private readonly workerIdBits = 5n;
  private readonly datacenterIdBits = 5n;
  private readonly maxWorkerId = ~(-1n << this.workerIdBits); // 31
  private readonly maxDataCenterId = ~(-1n << this.datacenterIdBits); // 31
  private readonly sequenceBits = 12n;

  private readonly workerIdShift = this.sequenceBits;
  private readonly datacenterIdShift = this.sequenceBits + this.workerIdBits;
  private readonly timestampLeftShift =
    this.sequenceBits + this.workerIdBits + this.datacenterIdBits;
  private readonly sequenceMask = ~(-1n << this.sequenceBits); // 4095

  constructor(workerId: number, dataCenterId: number) {
    if (workerId > Number(this.maxWorkerId) || workerId < 0) {
      throw new Error(`workerId must be between 0 and ${this.maxWorkerId}`);
    }
    if (dataCenterId > Number(this.maxDataCenterId) || dataCenterId < 0) {
      throw new Error(`dataCenterId must be between 0 and ${this.maxDataCenterId}`);
    }
    this.workerId = BigInt(workerId);
    this.dataCenterId = BigInt(dataCenterId);
  }

  nextId(): string {
    let timestamp = BigInt(Date.now());

    // 时钟回拨检测
    if (timestamp < this.lastTimestamp) {
      throw new Error(
        `Clock moved backwards. Refusing to generate id for ${this.lastTimestamp - timestamp}ms`,
      );
    }

    if (this.lastTimestamp === timestamp) {
      this.sequence = (this.sequence + 1n) & this.sequenceMask;
      if (this.sequence === 0n) {
        // 序列号溢出，等待下一毫秒
        timestamp = this.tilNextMillis(this.lastTimestamp);
      }
    } else {
      this.sequence = 0n;
    }

    this.lastTimestamp = timestamp;

    const id =
      ((timestamp - this.twepoch) << this.timestampLeftShift) |
      (this.dataCenterId << this.datacenterIdShift) |
      (this.workerId << this.workerIdShift) |
      this.sequence;

    return id.toString();
  }

  private tilNextMillis(lastTimestamp: bigint): bigint {
    let timestamp = BigInt(Date.now());
    while (timestamp <= lastTimestamp) {
      timestamp = BigInt(Date.now());
    }
    return timestamp;
  }
}

// 默认实例（使用随机 workerId 和 dataCenterId）
const defaultGenerator = new SnowflakeIdGeneratorImpl(
  Math.floor(Math.random() * 31),
  Math.floor(Math.random() * 31),
);

/**
 * Generate a Snowflake ID using the default generator instance.
 * Provides time-ordered, distributed-safe numeric string IDs.
 * @returns A numeric string Snowflake ID
 */
export function generateSnowflakeId(): string {
  return defaultGenerator.nextId();
}

/**
 * 创建自定义的雪花 ID 生成器实例
 */
export function createSnowflakeGenerator(
  workerId: number,
  dataCenterId: number,
): () => string {
  const gen = new SnowflakeIdGeneratorImpl(workerId, dataCenterId);
  return () => gen.nextId();
}

/**
 * 生成雪花 ID 的十六进制表示
 */
export function generateSnowflakeHexId(): string {
  const id = BigInt(defaultGenerator.nextId());
  return id.toString(16);
}

/**
 * 生成 MD5 哈希的 UUID
 *
 * 生成一个 UUID，再取其 MD5 摘要的十六进制字符串作为 ID。
 * 生成的 ID 为 32 个十六进制字符。
 */
export function generateMd5Id(): string {
  const uuid = randomUUID();
  return createHash('md5').update(uuid).digest('hex');
}

// ---- RandomIdGenerator ----

/**
 * instanceId 用于区分不同实例，避免分布式环境下 ID 冲突
 */
const defaultInstanceId = Math.floor(Math.random() * 127) + 1;

/**
 * 生成带时间戳的随机 ID（base64url 编码）
 *
 * ID 结构（24 字节）：
 * - byte[0]: instanceId
 * - byte[1..5]: 时间戳的低 40 位（毫秒）
 * - byte[6..23]: 18 字节随机数
 *
 * 编码后为 32 字符的 base64url 字符串（无 padding）。
 *
 * @param instanceId 实例 ID（0-127），默认使用随机值
 */
export function generateRandomId(instanceId = defaultInstanceId): string {
  const now = Date.now();
  const value = Buffer.alloc(24);

  value[0] = instanceId & 0xff;

  // 按大端顺序写入时间戳低 40 位 (5 字节)
  value[1] = (Math.floor(now / 0x100000000) & 0xff);
  value[2] = ((now >>> 24) & 0xff);
  value[3] = ((now >>> 16) & 0xff);
  value[4] = ((now >>> 8) & 0xff);
  value[5] = (now & 0xff);

  // 18 字节随机数
  const rand = randomBytes(18);
  rand.copy(value, 6);

  return value.toString('base64url');
}

/**
 * 判断字符串是否为 RandomId 格式
 *
 * 长度在 16-48 之间，且为合法的 base64url 字符
 */
export function isRandomId(id: string): boolean {
  if (id.length < 16 || id.length > 48) {
    return false;
  }
  return /^[A-Za-z0-9\-_]+={0,2}$/.test(id);
}

/**
 * 从 RandomId 中提取时间戳
 *
 * 提取 ID 中嵌入的创建时间戳（毫秒）。
 * 注意：由于只存储了低 40 位，需要用当前时间补齐高位。
 */
export function getTimestampInId(id: string): number {
  const bytes = Buffer.from(id, 'base64url');
  if (bytes.length < 6) {
    return -1;
  }
  const now = Date.now();
  // 用当前时间的高 24 位 + ID 中的低 40 位恢复时间戳
  const highBits = Math.floor(now / 0x10000000000) * 0x10000000000;
  const lowBits =
    (bytes[1] & 0xff) * 0x100000000 +
    ((bytes[2] & 0xff) << 24 |
     (bytes[3] & 0xff) << 16 |
     (bytes[4] & 0xff) << 8 |
     (bytes[5] & 0xff)) >>> 0;
  return highBits + lowBits;
}

/**
 * 判断 RandomId 的时间戳是否在指定时间范围内
 *
 * @param id 待检查的 ID
 * @param durationMs 允许的时间偏差（毫秒）
 */
export function isRandomIdInRange(id: string, durationMs: number): boolean {
  try {
    if (!isRandomId(id)) {
      return false;
    }
    const now = Date.now();
    const ts = getTimestampInId(id);
    return Math.abs(now - ts) <= durationMs;
  } catch {
    return false;
  }
}
