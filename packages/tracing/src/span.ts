import { randomUUID } from 'crypto';

export interface SpanEvent {
  name: string;
  timestamp: Date;
  attributes?: Record<string, unknown>;
}

/**
 * Span Link — 关联到其他 trace 的引用
 */
export interface SpanLink {
  traceId: string;
  spanId: string;
  attributes?: Record<string, unknown>;
}

export interface SpanOptions {
  parentSpanId?: string;
  /** Use this 16-hex span id (e.g. the id already sent in the response traceparent). */
  spanId?: string;
  traceId?: string;
  attributes?: Record<string, unknown>;
}

export type SpanStatus = 'UNSET' | 'OK' | 'ERROR';

export class Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly startTime: Date;
  endTime?: Date;
  attributes: Record<string, unknown>;
  events: SpanEvent[] = [];
  links: SpanLink[] = [];
  status: SpanStatus = 'UNSET';
  statusMessage?: string;

  constructor(name: string, options?: SpanOptions) {
    this.name = name;
    this.traceId = options?.traceId ?? randomUUID().replace(/-/g, '');
    this.spanId =
      options?.spanId && /^[0-9a-f]{16}$/.test(options.spanId) && !/^0+$/.test(options.spanId)
        ? options.spanId
        : randomUUID().replace(/-/g, '').substring(0, 16);
    this.parentSpanId = options?.parentSpanId;
    this.startTime = new Date();
    this.attributes = options?.attributes ?? {};
  }

  setAttribute(key: string, value: unknown): this {
    this.attributes[key] = value;
    return this;
  }

  setAttributes(attrs: Record<string, unknown>): this {
    Object.assign(this.attributes, attrs);
    return this;
  }

  addEvent(name: string, attributes?: Record<string, unknown>): this {
    this.events.push({ name, timestamp: new Date(), attributes });
    return this;
  }

  addLink(traceId: string, spanId: string, attributes?: Record<string, unknown>): this {
    this.links.push({ traceId, spanId, attributes });
    return this;
  }

  setStatus(status: SpanStatus, message?: string): this {
    this.status = status;
    this.statusMessage = message;
    return this;
  }

  end(): void {
    this.endTime = new Date();
  }

  get duration(): number | undefined {
    if (!this.endTime) return undefined;
    return this.endTime.getTime() - this.startTime.getTime();
  }

  isRecording(): boolean {
    return !this.endTime;
  }
}

/**
 * 流式构建 Span
 */
export class SpanBuilder {
  private _name: string;
  private options: SpanOptions = {};
  private _links: SpanLink[] = [];

  constructor(name: string) {
    this._name = name;
  }

  withTraceId(traceId: string): this {
    this.options.traceId = traceId;
    return this;
  }

  withParentSpanId(parentSpanId: string): this {
    this.options.parentSpanId = parentSpanId;
    return this;
  }

  withAttribute(key: string, value: unknown): this {
    if (!this.options.attributes) this.options.attributes = {};
    this.options.attributes[key] = value;
    return this;
  }

  withLink(traceId: string, spanId: string, attributes?: Record<string, unknown>): this {
    this._links.push({ traceId, spanId, attributes });
    return this;
  }

  build(): Span {
    const span = new Span(this._name, this.options);
    for (const link of this._links) {
      span.addLink(link.traceId, link.spanId, link.attributes);
    }
    return span;
  }
}
