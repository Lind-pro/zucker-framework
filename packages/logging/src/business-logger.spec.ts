import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter2 } from 'eventemitter2';
import { BusinessLogger, BUSINESS_LOG_EVENT, type BusinessLogBus } from './business-logger';
import { runWithCorrelationId } from './correlation-id';

describe('BusinessLogger', () => {
  let logger: BusinessLogger;
  let eventEmitter: EventEmitter2;
  let mockBus: BusinessLogBus;

  beforeEach(() => {
    eventEmitter = new EventEmitter2();
    mockBus = {
      publish: vi.fn().mockResolvedValue(undefined),
    };
    logger = new BusinessLogger(eventEmitter, mockBus);
  });

  describe('logOperation', () => {
    it('should emit a business log event via EventEmitter2', async () => {
      const handler = vi.fn();
      eventEmitter.on(BUSINESS_LOG_EVENT, handler);

      await logger.logOperation('user', 'create', 'user-123', 'Created user', 'admin');

      expect(handler).toHaveBeenCalledTimes(1);
      const entry = handler.mock.calls[0][0];
      expect(entry.module).toBe('user');
      expect(entry.action).toBe('create');
      expect(entry.target).toBe('user-123');
      expect(entry.detail).toBe('Created user');
      expect(entry.userId).toBe('admin');
      expect(entry.level).toBe('INFO');
    });

    it('should publish via remote bus when available', async () => {
      await logger.logOperation('user', 'create');
      expect(mockBus.publish).toHaveBeenCalledWith(
        'system/business-log',
        expect.objectContaining({ module: 'user', action: 'create' }),
      );
    });

    it('should include timestamp in ISO format', async () => {
      const handler = vi.fn();
      eventEmitter.on(BUSINESS_LOG_EVENT, handler);
      await logger.logOperation('mod', 'act');
      const entry = handler.mock.calls[0][0];
      expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('logWarning', () => {
    it('should log with WARN level', async () => {
      const handler = vi.fn();
      eventEmitter.on(BUSINESS_LOG_EVENT, handler);

      await logger.logWarning('inventory', 'low-stock', 'Stock below threshold', { sku: 'ABC' });

      const entry = handler.mock.calls[0][0];
      expect(entry.level).toBe('WARN');
      expect(entry.module).toBe('inventory');
      expect(entry.metadata).toEqual({ sku: 'ABC' });
    });
  });

  describe('logError', () => {
    it('should log with ERROR level', async () => {
      const handler = vi.fn();
      eventEmitter.on(BUSINESS_LOG_EVENT, handler);

      await logger.logError('payment', 'charge-failed', 'Insufficient funds', { orderId: '42' });

      const entry = handler.mock.calls[0][0];
      expect(entry.level).toBe('ERROR');
      expect(entry.detail).toBe('Insufficient funds');
      expect(entry.metadata).toEqual({ orderId: '42' });
    });
  });

  describe('correlationId propagation', () => {
    it('should include correlationId from context', async () => {
      const handler = vi.fn();
      eventEmitter.on(BUSINESS_LOG_EVENT, handler);

      await runWithCorrelationId('corr-999', async () => {
        await logger.logOperation('mod', 'act');
      });

      const entry = handler.mock.calls[0][0];
      expect(entry.correlationId).toBe('corr-999');
    });
  });

  describe('bus failure handling', () => {
    it('should not throw when remote bus publish fails', async () => {
      const failBus: BusinessLogBus = {
        publish: vi.fn().mockRejectedValue(new Error('bus down')),
      };
      const loggerWithFailBus = new BusinessLogger(eventEmitter, failBus);

      await expect(loggerWithFailBus.logOperation('mod', 'act')).resolves.toBeUndefined();
    });
  });

  describe('without remote bus', () => {
    it('should work without remote bus (optional)', async () => {
      const loggerNoBus = new BusinessLogger(eventEmitter);
      const handler = vi.fn();
      eventEmitter.on(BUSINESS_LOG_EVENT, handler);

      await loggerNoBus.logOperation('mod', 'act');
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('log method', () => {
    it('should accept full log params', async () => {
      const handler = vi.fn();
      eventEmitter.on(BUSINESS_LOG_EVENT, handler);

      await logger.log({
        module: 'custom',
        action: 'test',
        level: 'INFO',
        target: 'item-1',
        targetType: 'item',
        detail: 'detail text',
        userId: 'user-1',
        metadata: { key: 'val' },
      });

      const entry = handler.mock.calls[0][0];
      expect(entry.module).toBe('custom');
      expect(entry.targetType).toBe('item');
      expect(entry.metadata).toEqual({ key: 'val' });
    });
  });
});
