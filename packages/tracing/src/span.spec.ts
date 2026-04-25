import { describe, it, expect } from 'vitest';
import { Span, SpanBuilder } from './span';

describe('Span', () => {
  it('should create a span with generated traceId and spanId', () => {
    const span = new Span('test-op');
    expect(span.name).toBe('test-op');
    expect(span.traceId).toBeDefined();
    expect(span.traceId.length).toBe(32);
    expect(span.spanId).toBeDefined();
    expect(span.spanId.length).toBe(16);
    expect(span.startTime).toBeInstanceOf(Date);
  });

  it('should accept custom traceId and parentSpanId', () => {
    const span = new Span('child-op', {
      traceId: 'aaaa'.repeat(8),
      parentSpanId: 'bbbb'.repeat(4),
    });
    expect(span.traceId).toBe('aaaa'.repeat(8));
    expect(span.parentSpanId).toBe('bbbb'.repeat(4));
  });

  it('should set and chain attributes', () => {
    const span = new Span('op');
    const result = span.setAttribute('key1', 'value1').setAttribute('key2', 42);
    expect(result).toBe(span);
    expect(span.attributes['key1']).toBe('value1');
    expect(span.attributes['key2']).toBe(42);
  });

  it('should set multiple attributes at once', () => {
    const span = new Span('op');
    span.setAttributes({ a: 1, b: 'two' });
    expect(span.attributes).toEqual({ a: 1, b: 'two' });
  });

  it('should add events with timestamps', () => {
    const span = new Span('op');
    span.addEvent('checkpoint', { step: 1 });
    expect(span.events).toHaveLength(1);
    expect(span.events[0].name).toBe('checkpoint');
    expect(span.events[0].timestamp).toBeInstanceOf(Date);
    expect(span.events[0].attributes).toEqual({ step: 1 });
  });

  it('should add links to other traces', () => {
    const span = new Span('op');
    span.addLink('trace-abc', 'span-def', { reason: 'causal' });
    expect(span.links).toHaveLength(1);
    expect(span.links[0].traceId).toBe('trace-abc');
    expect(span.links[0].spanId).toBe('span-def');
  });

  it('should set status and status message', () => {
    const span = new Span('op');
    expect(span.status).toBe('UNSET');
    span.setStatus('ERROR', 'something failed');
    expect(span.status).toBe('ERROR');
    expect(span.statusMessage).toBe('something failed');
  });

  it('should end the span and compute duration', () => {
    const span = new Span('op');
    expect(span.isRecording()).toBe(true);
    expect(span.duration).toBeUndefined();
    span.end();
    expect(span.isRecording()).toBe(false);
    expect(span.endTime).toBeInstanceOf(Date);
    expect(typeof span.duration).toBe('number');
    expect(span.duration!).toBeGreaterThanOrEqual(0);
  });

  it('should accept initial attributes via options', () => {
    const span = new Span('op', { attributes: { env: 'test' } });
    expect(span.attributes['env']).toBe('test');
  });
});

describe('SpanBuilder', () => {
  it('should build a span with the given name', () => {
    const span = new SpanBuilder('builder-op').build();
    expect(span.name).toBe('builder-op');
  });

  it('should set traceId via builder', () => {
    const traceId = 'abcd'.repeat(8);
    const span = new SpanBuilder('op').withTraceId(traceId).build();
    expect(span.traceId).toBe(traceId);
  });

  it('should set parentSpanId via builder', () => {
    const span = new SpanBuilder('op').withParentSpanId('parent123456789a').build();
    expect(span.parentSpanId).toBe('parent123456789a');
  });

  it('should set attributes via builder', () => {
    const span = new SpanBuilder('op')
      .withAttribute('service', 'api')
      .withAttribute('version', '1.0')
      .build();
    expect(span.attributes['service']).toBe('api');
    expect(span.attributes['version']).toBe('1.0');
  });

  it('should add links via builder', () => {
    const span = new SpanBuilder('op')
      .withLink('t1', 's1', { rel: 'follows' })
      .withLink('t2', 's2')
      .build();
    expect(span.links).toHaveLength(2);
    expect(span.links[0].traceId).toBe('t1');
    expect(span.links[1].traceId).toBe('t2');
  });

  it('should chain builder methods fluently', () => {
    const builder = new SpanBuilder('op');
    const result = builder.withTraceId('x'.repeat(32)).withParentSpanId('y'.repeat(16));
    expect(result).toBe(builder);
  });

  it('should create independent span instances', () => {
    const builder = new SpanBuilder('op').withAttribute('key', 'val');
    const s1 = builder.build();
    const s2 = builder.build();
    expect(s1).not.toBe(s2);
    expect(s1.spanId).not.toBe(s2.spanId);
  });

  it('should build span with all options combined', () => {
    const span = new SpanBuilder('full-op')
      .withTraceId('a'.repeat(32))
      .withParentSpanId('b'.repeat(16))
      .withAttribute('env', 'prod')
      .withLink('c'.repeat(32), 'd'.repeat(16))
      .build();
    expect(span.name).toBe('full-op');
    expect(span.traceId).toBe('a'.repeat(32));
    expect(span.parentSpanId).toBe('b'.repeat(16));
    expect(span.attributes['env']).toBe('prod');
    expect(span.links).toHaveLength(1);
  });
});
