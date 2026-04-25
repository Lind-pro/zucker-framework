import { describe, it, expect } from 'vitest';
import {
  convertVariableValue,
  renderVariableMap,
  NotifyChannel,
  DefaultNotifyType,
  createNotifyType,
  createNotifyProvider,
  type VariableDefinition,
} from './notifier.interface';

describe('convertVariableValue', () => {
  it('should return string representation of simple values', () => {
    const def: VariableDefinition = { id: 'name', name: 'Name' };
    expect(convertVariableValue(def, 'hello')).toBe('hello');
  });

  it('should apply default value when value is null', () => {
    const def: VariableDefinition = { id: 'x', name: 'X', defaultValue: 'fallback' };
    expect(convertVariableValue(def, null)).toBe('fallback');
  });

  it('should apply default value when value is undefined', () => {
    const def: VariableDefinition = { id: 'x', name: 'X', defaultValue: 'fb' };
    expect(convertVariableValue(def, undefined)).toBe('fb');
  });

  it('should throw when required variable is missing', () => {
    const def: VariableDefinition = { id: 'req', name: 'Required', required: true };
    expect(() => convertVariableValue(def, undefined)).toThrow("Template variable 'req' (Required) is required");
  });

  it('should throw when required variable is empty string', () => {
    const def: VariableDefinition = { id: 'req', name: 'Required', required: true };
    expect(() => convertVariableValue(def, '')).toThrow("is required");
  });

  it('should format number with precision', () => {
    const def: VariableDefinition = { id: 'val', name: 'Value', type: 'number', format: '%.2f' };
    expect(convertVariableValue(def, 3.14159)).toBe('3.14');
  });

  it('should format number with zero decimal places', () => {
    const def: VariableDefinition = { id: 'val', name: 'Value', type: 'number', format: '%.0f' };
    expect(convertVariableValue(def, 42.7)).toBe('43');
  });

  it('should format date with default pattern', () => {
    const def: VariableDefinition = { id: 'd', name: 'Date', type: 'date' };
    const date = new Date(2024, 0, 15, 10, 30, 45); // Jan 15, 2024 10:30:45
    const result = convertVariableValue(def, date);
    expect(result).toBe('2024-01-15 10:30:45');
  });

  it('should format date as timestamp', () => {
    const def: VariableDefinition = { id: 'd', name: 'Date', type: 'date', format: 'timestamp' };
    const date = new Date(1700000000000);
    expect(convertVariableValue(def, date)).toBe('1700000000000');
  });

  it('should handle invalid date by returning string representation', () => {
    const def: VariableDefinition = { id: 'd', name: 'Date', type: 'date' };
    expect(convertVariableValue(def, 'not-a-date')).toBe('not-a-date');
  });

  it('should join array values with comma', () => {
    const def: VariableDefinition = { id: 'tags', name: 'Tags' };
    expect(convertVariableValue(def, ['a', 'b', 'c'])).toBe('a,b,c');
  });

  it('should return empty string for null without default', () => {
    const def: VariableDefinition = { id: 'x', name: 'X' };
    expect(convertVariableValue(def, null)).toBe('');
  });
});

describe('renderVariableMap', () => {
  it('should apply variable definitions to matching keys', () => {
    const defs: VariableDefinition[] = [
      { id: 'price', name: 'Price', type: 'number', format: '%.1f' },
    ];
    const result = renderVariableMap({ price: 9.99, other: 'keep' }, defs);
    expect(result.price).toBe('10.0');
    expect(result.other).toBe('keep');
  });

  it('should pass through values without matching definitions', () => {
    const result = renderVariableMap({ foo: 'bar' }, []);
    expect(result.foo).toBe('bar');
  });
});

describe('DefaultNotifyType', () => {
  it('should have correct IDs for all channels', () => {
    expect(DefaultNotifyType[NotifyChannel.EMAIL].getId()).toBe('email');
    expect(DefaultNotifyType[NotifyChannel.SMS].getId()).toBe('sms');
    expect(DefaultNotifyType[NotifyChannel.WEBHOOK].getId()).toBe('webhook');
  });
});

describe('createNotifyType', () => {
  it('should create a custom notify type', () => {
    const custom = createNotifyType('custom', 'Custom Channel');
    expect(custom.getId()).toBe('custom');
    expect(custom.getName()).toBe('Custom Channel');
  });
});

describe('createNotifyProvider', () => {
  it('should create a provider identifier', () => {
    const provider = createNotifyProvider('aliyun', 'Aliyun');
    expect(provider.getId()).toBe('aliyun');
    expect(provider.getName()).toBe('Aliyun');
  });
});
