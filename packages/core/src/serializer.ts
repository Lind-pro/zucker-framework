/**
 * 对象序列化器接口
 */
export interface ObjectSerializer {
  serialize(obj: unknown): Buffer;
  deserialize<T = unknown>(data: Buffer): T;
  contentType(): string;
}

/**
 * JSON 序列化实现
 */
export class JsonSerializer implements ObjectSerializer {
  serialize(obj: unknown): Buffer {
    return Buffer.from(JSON.stringify(obj, this.replacer));
  }

  deserialize<T = unknown>(data: Buffer): T {
    return JSON.parse(data.toString('utf-8'), this.reviver) as T;
  }

  contentType(): string {
    return 'application/json';
  }

  private replacer(_key: string, value: unknown): unknown {
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (typeof value === 'bigint') {
      return value.toString();
    }
    return value;
  }

  private reviver(_key: string, value: unknown): unknown {
    if (typeof value === 'string') {
      return SmartDateDeserializer.tryParse(value) ?? value;
    }
    return value;
  }
}

/**
 * 序列化器注册中心 — 按 content-type 注册序列化器
 */
export class SerializerRegistry {
  private serializers = new Map<string, ObjectSerializer>();

  constructor() {
    // 默认注册 JSON 序列化器
    const json = new JsonSerializer();
    this.register(json);
  }

  register(serializer: ObjectSerializer): void {
    this.serializers.set(serializer.contentType(), serializer);
  }

  get(contentType: string): ObjectSerializer | undefined {
    return this.serializers.get(contentType);
  }

  getOrThrow(contentType: string): ObjectSerializer {
    const s = this.serializers.get(contentType);
    if (!s) throw new Error(`No serializer registered for content-type: ${contentType}`);
    return s;
  }

  getDefault(): ObjectSerializer {
    return this.getOrThrow('application/json');
  }
}

/**
 * 智能日期解析 — ISO、时间戳、自定义格式
 */
export class SmartDateDeserializer {
  // ISO 8601 格式
  private static readonly ISO_REGEX =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

  /**
   * 尝试将字符串解析为 Date，如果不是日期格式则返回 undefined
   */
  static tryParse(value: string): Date | undefined {
    // ISO 格式
    if (this.ISO_REGEX.test(value)) {
      const date = new Date(value);
      if (!isNaN(date.getTime())) return date;
    }

    return undefined;
  }

  /**
   * 解析字符串或数字为 Date
   */
  static parse(value: string | number): Date {
    if (typeof value === 'number') {
      // 自动判断秒级/毫秒级时间戳
      if (value < 1e12) {
        return new Date(value * 1000); // 秒级
      }
      return new Date(value); // 毫秒级
    }

    // 纯数字字符串视为时间戳
    if (/^\d+$/.test(value)) {
      return this.parse(Number(value));
    }

    const date = new Date(value);
    if (isNaN(date.getTime())) {
      throw new Error(`Cannot parse date: ${value}`);
    }
    return date;
  }
}
