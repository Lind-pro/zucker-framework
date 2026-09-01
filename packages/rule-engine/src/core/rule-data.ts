/**
 * RuleData wraps data flowing through the rule engine graph,
 * carrying context headers alongside the payload — mirrors
 * jetlinks RuleData / RuleDataHelper.
 */
export interface RuleDataHeaders {
  /** Originating rule instance id */
  ruleId?: string;
  /** Node that produced this data */
  nodeId?: string;
  /** Arbitrary context passed between nodes */
  [key: string]: unknown;
}

export class RuleData {
  readonly id: string;
  private _data: unknown;
  private readonly _headers: RuleDataHeaders;
  private readonly _contextMap: Map<string, unknown>;

  constructor(data: unknown, headers?: RuleDataHeaders) {
    this.id = RuleData.generateId();
    this._data = data;
    this._headers = { ...headers };
    this._contextMap = new Map();
  }

  static of(data: unknown): RuleData {
    return new RuleData(data);
  }

  /** Create a new RuleData sharing headers but replacing the payload. */
  newData(data: unknown): RuleData {
    const rd = new RuleData(data, this._headers);
    for (const [k, v] of this._contextMap) {
      rd._contextMap.set(k, v);
    }
    return rd;
  }

  getData(): unknown {
    return this._data;
  }

  setData(data: unknown): void {
    this._data = data;
  }

  getHeader(key: string): unknown {
    return this._headers[key];
  }

  setHeader(key: string, value: unknown): void {
    this._headers[key] = value;
  }

  getHeaders(): Readonly<RuleDataHeaders> {
    return this._headers;
  }

  /** Record current data into headers under `key` (used for serial chaining). */
  recordToHeader(key: string): void {
    this._headers[key] = this._data;
  }

  /** Get a context map entry. */
  getContextEntry(key: string): unknown {
    return this._contextMap.get(key);
  }

  /** Set a context map entry — mirrors jetlinks RuleDataHelper.setContextData(). */
  setContextEntry(key: string, value: unknown): void {
    this._contextMap.set(key, value);
  }

  /** Retrieve the full context map (plain object view of data).
   *  Merges data + headers + contextMap — aligned with jetlinks RuleDataHelper.toContextMap(). */
  toContextMap(): Record<string, unknown> {
    const base: Record<string, unknown> = typeof this._data === 'object' && this._data !== null
      ? { ...(this._data as Record<string, unknown>) }
      : { value: this._data };

    // merge context map entries (lower priority than data)
    for (const [k, v] of this._contextMap) {
      if (v !== undefined && !(k in base)) {
        base[k] = v;
      }
    }

    // merge headers (highest priority)
    for (const [k, v] of Object.entries(this._headers)) {
      if (v !== undefined) {
        base[k] = v;
      }
    }
    return base;
  }

  private static _counter = 0;
  private static generateId(): string {
    return `rd_${Date.now()}_${++RuleData._counter}`;
  }
}
