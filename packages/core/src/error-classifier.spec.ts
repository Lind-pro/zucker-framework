import { describe, it, expect } from 'vitest';
import { classifyError, classificationToException, withRetry } from './error-classifier';
import { BusinessException, NotFoundException, ConflictException, TimeoutException } from './exceptions';

describe('classifyError', () => {
  describe('BusinessException passthrough', () => {
    it('should preserve BusinessException as-is', () => {
      const err = new BusinessException('bad input', 'BAD_INPUT', 400);
      const cls = classifyError(err);
      expect(cls.retryable).toBe(false);
      expect(cls.code).toBe('BAD_INPUT');
      expect(cls.status).toBe(400);
    });
  });

  describe('Prisma error codes', () => {
    it('should classify P2002 as unique constraint (409, not retryable)', () => {
      const err = Object.assign(new Error('unique'), { code: 'P2002' });
      const cls = classifyError(err);
      expect(cls.retryable).toBe(false);
      expect(cls.code).toBe('UNIQUE_CONSTRAINT');
      expect(cls.status).toBe(409);
    });

    it('should classify P2025 as not found (404)', () => {
      const err = Object.assign(new Error('not found'), { code: 'P2025' });
      const cls = classifyError(err);
      expect(cls.retryable).toBe(false);
      expect(cls.code).toBe('NOT_FOUND');
      expect(cls.status).toBe(404);
    });

    it('should classify P2034 as transaction conflict (retryable)', () => {
      const err = Object.assign(new Error('write conflict'), { code: 'P2034' });
      const cls = classifyError(err);
      expect(cls.retryable).toBe(true);
      expect(cls.code).toBe('TRANSACTION_CONFLICT');
      expect(cls.retryAfterMs).toBe(100);
    });

    it('should classify P1001 as unreachable (retryable)', () => {
      const err = Object.assign(new Error('db down'), { code: 'P1001' });
      const cls = classifyError(err);
      expect(cls.retryable).toBe(true);
      expect(cls.code).toBe('DB_UNREACHABLE');
      expect(cls.status).toBe(503);
    });
  });

  describe('timeout detection', () => {
    it('should detect "timeout" in message', () => {
      const cls = classifyError(new Error('Connection timeout'));
      expect(cls.retryable).toBe(true);
      expect(cls.code).toBe('TIMEOUT');
      expect(cls.status).toBe(504);
    });

    it('should detect "timed out" in message', () => {
      const cls = classifyError(new Error('Query timed out'));
      expect(cls.retryable).toBe(true);
      expect(cls.code).toBe('TIMEOUT');
    });

    it('should detect "ETIMEDOUT" in message', () => {
      const cls = classifyError(new Error('connect ETIMEDOUT'));
      expect(cls.retryable).toBe(true);
      expect(cls.code).toBe('TIMEOUT');
    });
  });

  describe('connection error detection', () => {
    it('should detect ECONNREFUSED', () => {
      const cls = classifyError(new Error('connect ECONNREFUSED 127.0.0.1:5432'));
      expect(cls.retryable).toBe(true);
      expect(cls.code).toBe('CONNECTION_ERROR');
      expect(cls.status).toBe(503);
    });

    it('should detect ECONNRESET', () => {
      const cls = classifyError(new Error('read ECONNRESET'));
      expect(cls.retryable).toBe(true);
      expect(cls.code).toBe('CONNECTION_ERROR');
    });
  });

  describe('default classification', () => {
    it('should classify unknown errors as non-retryable 500', () => {
      const cls = classifyError(new Error('something unexpected'));
      expect(cls.retryable).toBe(false);
      expect(cls.code).toBe('INTERNAL_ERROR');
      expect(cls.status).toBe(500);
    });

    it('should handle non-Error values', () => {
      const cls = classifyError('string error');
      expect(cls.retryable).toBe(false);
      expect(cls.message).toBe('string error');
    });
  });
});

describe('classificationToException', () => {
  it('should create NotFoundException for 404', () => {
    const exc = classificationToException({
      retryable: false, code: 'NOT_FOUND', status: 404, message: 'gone', cause: null,
    });
    expect(exc).toBeInstanceOf(NotFoundException);
  });

  it('should create ConflictException for 409', () => {
    const exc = classificationToException({
      retryable: false, code: 'CONFLICT', status: 409, message: 'dup', cause: null,
    });
    expect(exc).toBeInstanceOf(ConflictException);
  });

  it('should create TimeoutException for 504', () => {
    const exc = classificationToException({
      retryable: false, code: 'TIMEOUT', status: 504, message: 'slow', cause: null,
    });
    expect(exc).toBeInstanceOf(TimeoutException);
  });

  it('should create BusinessException for other codes', () => {
    const exc = classificationToException({
      retryable: false, code: 'CUSTOM', status: 422, message: 'bad', cause: null,
    });
    expect(exc).toBeInstanceOf(BusinessException);
    expect(exc.status).toBe(422);
  });
});

describe('withRetry', () => {
  it('should return result on first success', async () => {
    const result = await withRetry(async () => 42);
    expect(result).toBe(42);
  });

  it('should retry retryable errors', async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      if (attempts < 3) {
        throw Object.assign(new Error('write conflict'), { code: 'P2034' });
      }
      return 'success';
    }, 3);

    expect(result).toBe('success');
    expect(attempts).toBe(3);
  });

  it('should throw immediately for non-retryable errors', async () => {
    await expect(
      withRetry(async () => {
        throw new NotFoundException('not here');
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('should throw after maxRetries exhausted', async () => {
    await expect(
      withRetry(async () => {
        throw Object.assign(new Error('db down'), { code: 'P1001' });
      }, 1),
    ).rejects.toThrow(BusinessException);
  });
});
