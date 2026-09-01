import { describe, it, expect } from 'vitest';
import {
  createMessageId,
  createReportPropertyMessage,
  createEventMessage,
} from './message';

describe('createMessageId', () => {
  it('returns a non-empty string', () => {
    expect(typeof createMessageId()).toBe('string');
    expect(createMessageId().length).toBeGreaterThan(0);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, createMessageId));
    expect(ids.size).toBe(100);
  });
});

describe('createReportPropertyMessage', () => {
  it('creates message with correct type and fields', () => {
    const msg = createReportPropertyMessage('d1', 'sensor', { temperature: 25.3 });
    expect(msg.messageType).toBe('ReportProperty');
    expect(msg.thingId).toBe('d1');
    expect(msg.thingType).toBe('sensor');
    expect(msg.properties['temperature']).toBe(25.3);
    expect(msg.messageId).toBeTruthy();
    expect(msg.timestamp).toBeGreaterThan(0);
  });

  it('accepts extra overrides', () => {
    const ts = 1_700_000_000_000;
    const msg = createReportPropertyMessage('d1', 'sensor', { v: 1 }, { timestamp: ts });
    expect(msg.timestamp).toBe(ts);
  });
});

describe('createEventMessage', () => {
  it('creates event message with correct structure', () => {
    const msg = createEventMessage('d1', 'sensor', 'alarm', { level: 'high' });
    expect(msg.messageType).toBe('Event');
    expect(msg.event).toBe('alarm');
    expect(msg.data).toEqual({ level: 'high' });
    expect(msg.thingId).toBe('d1');
  });
});
