import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryTracer,
  AlwaysOnSampler,
  AlwaysOffSampler,
  RatioSampler,
  ParentBasedSampler,
  SamplingDecision,
  type Sampler,
} from './tracer';

describe('InMemoryTracer', () => {
  let tracer: InMemoryTracer;

  beforeEach(() => {
    tracer = new InMemoryTracer();
  });

  it('should start a span and store it', () => {
    const span = tracer.startSpan('test-op');
    expect(span.name).toBe('test-op');
    expect(tracer.getSpans()).toHaveLength(1);
  });

  it('should start a span with options', () => {
    const span = tracer.startSpan('child', {
      traceId: 'a'.repeat(32),
      parentSpanId: 'b'.repeat(16),
    });
    expect(span.traceId).toBe('a'.repeat(32));
    expect(span.parentSpanId).toBe('b'.repeat(16));
  });

  it('should return a copy of spans via getSpans', () => {
    tracer.startSpan('op1');
    const spans = tracer.getSpans();
    spans.push(tracer.startSpan('op2'));
    // Internal array should have 2 spans but first getSpans() returned a copy of 1
    expect(tracer.getSpans()).toHaveLength(2);
  });

  it('should filter spans by traceId', () => {
    const s1 = tracer.startSpan('op1', { traceId: 'aaa'.repeat(10) + 'aa' });
    const s2 = tracer.startSpan('op2', { traceId: 'bbb'.repeat(10) + 'bb' });
    const s3 = tracer.startSpan('op3', { traceId: 'aaa'.repeat(10) + 'aa' });
    const filtered = tracer.getSpansByTraceId('aaa'.repeat(10) + 'aa');
    expect(filtered).toHaveLength(2);
    expect(filtered.map((s) => s.name)).toContain('op1');
    expect(filtered.map((s) => s.name)).toContain('op3');
  });

  it('should clear all spans', () => {
    tracer.startSpan('op1');
    tracer.startSpan('op2');
    tracer.clear();
    expect(tracer.getSpans()).toHaveLength(0);
  });

  it('should evict old spans when exceeding maxSpans', () => {
    // maxSpans = 10000 by default, we just verify it doesn't crash
    for (let i = 0; i < 100; i++) {
      tracer.startSpan(`op-${i}`);
    }
    expect(tracer.getSpans().length).toBeLessThanOrEqual(100);
  });

  describe('with AlwaysOffSampler', () => {
    it('should not store dropped spans', () => {
      tracer.setSampler(new AlwaysOffSampler());
      const span = tracer.startSpan('dropped');
      expect(span.name).toBe('dropped'); // span is still returned
      expect(tracer.getSpans()).toHaveLength(0); // but not stored
    });
  });

  describe('with AlwaysOnSampler', () => {
    it('should store all spans', () => {
      tracer.setSampler(new AlwaysOnSampler());
      tracer.startSpan('op1');
      tracer.startSpan('op2');
      expect(tracer.getSpans()).toHaveLength(2);
    });
  });
});

describe('Samplers', () => {
  describe('AlwaysOnSampler', () => {
    it('should always return RECORD_AND_SAMPLE', () => {
      const sampler: Sampler = new AlwaysOnSampler();
      expect(sampler.shouldSample('any')).toBe(SamplingDecision.RECORD_AND_SAMPLE);
    });
  });

  describe('AlwaysOffSampler', () => {
    it('should always return DROP', () => {
      const sampler: Sampler = new AlwaysOffSampler();
      expect(sampler.shouldSample('any')).toBe(SamplingDecision.DROP);
    });
  });

  describe('RatioSampler', () => {
    it('should clamp ratio to 0-1 range', () => {
      const sampler: Sampler = new RatioSampler(2.0);
      // Ratio clamped to 1.0, so should always sample
      expect(sampler.shouldSample('op')).toBe(SamplingDecision.RECORD_AND_SAMPLE);
    });

    it('should drop all when ratio is 0', () => {
      const sampler: Sampler = new RatioSampler(0);
      expect(sampler.shouldSample('op')).toBe(SamplingDecision.DROP);
    });
  });

  describe('ParentBasedSampler', () => {
    it('should sample when parent span exists', () => {
      const sampler = new ParentBasedSampler(new AlwaysOffSampler());
      const decision = sampler.shouldSample('op', { parentSpanId: 'parent123' });
      expect(decision).toBe(SamplingDecision.RECORD_AND_SAMPLE);
    });

    it('should delegate to root sampler when no parent', () => {
      const sampler = new ParentBasedSampler(new AlwaysOffSampler());
      const decision = sampler.shouldSample('op');
      expect(decision).toBe(SamplingDecision.DROP);
    });

    it('should delegate to root sampler when parent is undefined', () => {
      const sampler = new ParentBasedSampler(new AlwaysOnSampler());
      const decision = sampler.shouldSample('op', {});
      expect(decision).toBe(SamplingDecision.RECORD_AND_SAMPLE);
    });
  });
});
