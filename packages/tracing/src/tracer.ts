import { Injectable } from '@nestjs/common';
import { Span, SpanOptions } from './span';

/**
 * 采样决策
 */
export enum SamplingDecision {
  /** 不采样，不记录 */
  DROP = 'DROP',
  /** 记录但不采样（不导出） */
  RECORD_ONLY = 'RECORD_ONLY',
  /** 记录并采样（导出） */
  RECORD_AND_SAMPLE = 'RECORD_AND_SAMPLE',
}

/**
 * 采样策略接口
 */
export interface Sampler {
  shouldSample(spanName: string, options?: SpanOptions): SamplingDecision;
}

/**
 * 全部采样
 */
export class AlwaysOnSampler implements Sampler {
  shouldSample(): SamplingDecision {
    return SamplingDecision.RECORD_AND_SAMPLE;
  }
}

/**
 * 全不采样
 */
export class AlwaysOffSampler implements Sampler {
  shouldSample(): SamplingDecision {
    return SamplingDecision.DROP;
  }
}

/**
 * 按比率采样
 */
export class RatioSampler implements Sampler {
  constructor(private readonly ratio: number) {
    this.ratio = Math.max(0, Math.min(1, ratio));
  }

  shouldSample(): SamplingDecision {
    return Math.random() < this.ratio
      ? SamplingDecision.RECORD_AND_SAMPLE
      : SamplingDecision.DROP;
  }
}

/**
 * 基于父级 Span 的采样决策
 * 如果有父 Span（继承链），沿用其采样决策；否则使用委托采样器
 */
export class ParentBasedSampler implements Sampler {
  constructor(private readonly root: Sampler) {}

  shouldSample(spanName: string, options?: SpanOptions): SamplingDecision {
    // 如果有 parentSpanId，说明父级已被采样，继续采样
    if (options?.parentSpanId) {
      return SamplingDecision.RECORD_AND_SAMPLE;
    }
    return this.root.shouldSample(spanName, options);
  }
}

export interface Tracer {
  startSpan(name: string, options?: SpanOptions): Span;
  getSpans(): Span[];
}

/**
 * 默认内存实现的 Tracer，支持采样策略
 */
@Injectable()
export class InMemoryTracer implements Tracer {
  private spans: Span[] = [];
  private maxSpans = 10000;
  private sampler: Sampler;

  constructor(sampler?: Sampler) {
    this.sampler = sampler ?? new AlwaysOnSampler();
  }

  setSampler(sampler: Sampler): void {
    this.sampler = sampler;
  }

  startSpan(name: string, options?: SpanOptions): Span {
    const span = new Span(name, options);

    const decision = this.sampler.shouldSample(name, options);
    if (decision === SamplingDecision.DROP) {
      // 返回 span 但不存储（调用方仍可使用，只是不记录）
      return span;
    }

    this.spans.push(span);

    // 防止内存泄漏
    if (this.spans.length > this.maxSpans) {
      this.spans = this.spans.slice(-this.maxSpans / 2);
    }

    return span;
  }

  getSpans(): Span[] {
    return [...this.spans];
  }

  getSpansByTraceId(traceId: string): Span[] {
    return this.spans.filter((s) => s.traceId === traceId);
  }

  clear(): void {
    this.spans = [];
  }
}
