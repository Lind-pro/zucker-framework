import { describe, it, expect, vi } from 'vitest';
import { HttpException, HttpStatus, ArgumentsHost } from '@nestjs/common';
import {
  BusinessException,
  ValidationException,
  NotFoundException,
  UnauthorizedException,
  ForbiddenException,
} from '@zucker/core';
import { HttpExceptionFilter } from './http-exception.filter';

// ─── Helpers ─────────────────────────────────────────────────────────

function createMockHost() {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const response = { status };

  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({}),
    }),
  } as unknown as ArgumentsHost;

  return { host, status, json };
}

function catchAndGetResponse(filter: HttpExceptionFilter, exception: unknown) {
  const { host, status, json } = createMockHost();
  filter.catch(exception, host);
  return {
    statusCode: status.mock.calls[0][0],
    body: json.mock.calls[0][0],
  };
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('HttpExceptionFilter', () => {
  const filter = new HttpExceptionFilter();

  // ─── BusinessException hierarchy ─────────────────────────────────

  describe('BusinessException', () => {
    it('should handle BusinessException with custom code and status', () => {
      const { statusCode, body } = catchAndGetResponse(
        filter,
        new BusinessException('something went wrong', 'CUSTOM_ERROR', 422),
      );

      expect(statusCode).toBe(422);
      expect(body.code).toBe('CUSTOM_ERROR');
      expect(body.message).toBe('something went wrong');
      expect(body.timestamp).toBeTypeOf('number');
    });

    it('should handle NotFoundException', () => {
      const { statusCode, body } = catchAndGetResponse(
        filter,
        new NotFoundException('user not found'),
      );

      expect(statusCode).toBe(404);
      expect(body.code).toBe('NOT_FOUND');
    });

    it('should handle UnauthorizedException', () => {
      const { statusCode, body } = catchAndGetResponse(
        filter,
        new UnauthorizedException(),
      );

      expect(statusCode).toBe(401);
      expect(body.code).toBe('UNAUTHORIZED');
    });

    it('should handle ForbiddenException', () => {
      const { statusCode, body } = catchAndGetResponse(
        filter,
        new ForbiddenException(),
      );

      expect(statusCode).toBe(403);
      expect(body.code).toBe('FORBIDDEN');
    });

    it('should include details when present', () => {
      const { body } = catchAndGetResponse(
        filter,
        new BusinessException('fail', 'ERR', 400, { extra: 'info' }),
      );

      expect(body.result).toEqual({ extra: 'info' });
    });
  });

  // ─── ValidationException ─────────────────────────────────────────

  describe('ValidationException', () => {
    it('should return 400 with validation details', () => {
      const { statusCode, body } = catchAndGetResponse(
        filter,
        new ValidationException({ email: ['invalid email format'] }),
      );

      expect(statusCode).toBe(400);
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(body.result).toEqual([
        { property: 'email', message: 'invalid email format' },
      ]);
    });

    it('should handle multiple validation errors', () => {
      const { body } = catchAndGetResponse(
        filter,
        new ValidationException({
          name: ['required'],
          email: ['invalid', 'too long'],
        }),
      );

      expect(body.result).toHaveLength(3);
    });
  });

  // ─── NestJS HttpException ────────────────────────────────────────

  describe('HttpException', () => {
    it('should handle standard HttpException with string response', () => {
      const { statusCode, body } = catchAndGetResponse(
        filter,
        new HttpException('Bad request', HttpStatus.BAD_REQUEST),
      );

      expect(statusCode).toBe(400);
      expect(body.code).toBe('BAD_REQUEST');
      expect(body.message).toBe('Bad request');
    });

    it('should handle HttpException with object response containing message array', () => {
      const { statusCode, body } = catchAndGetResponse(
        filter,
        new HttpException(
          { message: ['field1 is required', 'field2 must be a number'], error: 'VALIDATION' },
          HttpStatus.BAD_REQUEST,
        ),
      );

      expect(statusCode).toBe(400);
      expect(body.code).toBe('VALIDATION');
      expect(body.message).toBe('field1 is required');
      expect(body.result).toEqual(['field1 is required', 'field2 must be a number']);
    });

    it('should handle 429 TooManyRequests with retryAfter', () => {
      const { statusCode, body } = catchAndGetResponse(
        filter,
        new HttpException(
          { message: 'rate limited', retryAfter: 60 },
          HttpStatus.TOO_MANY_REQUESTS,
        ),
      );

      expect(statusCode).toBe(429);
      expect(body.result).toEqual({ retryAfter: 60 });
    });
  });

  // ─── Unknown errors ──────────────────────────────────────────────

  describe('Unknown errors', () => {
    it('should handle generic Error as 500', () => {
      const { statusCode, body } = catchAndGetResponse(
        filter,
        new Error('unexpected failure'),
      );

      expect(statusCode).toBe(500);
      expect(body.code).toBe('INTERNAL_ERROR');
      expect(body.message).toBe('unexpected failure');
    });

    it('should handle non-Error throws as 500', () => {
      const { statusCode, body } = catchAndGetResponse(filter, 'string error');

      expect(statusCode).toBe(500);
      expect(body.code).toBe('INTERNAL_ERROR');
      expect(body.message).toBe('string error');
    });
  });

  // ─── Duck-typing for cross-module boundaries ─────────────────────

  describe('duck-typing fallback', () => {
    it('should handle business-like errors from different module instances', () => {
      // Simulate a cross-boundary error that is not instanceof BusinessException
      // but has the same shape
      const fakeBizError = Object.assign(new Error('cross-boundary'), {
        status: 409,
        code: 'CONFLICT',
      });

      const { statusCode, body } = catchAndGetResponse(filter, fakeBizError);

      expect(statusCode).toBe(409);
      expect(body.code).toBe('CONFLICT');
    });
  });

  // ─── Response format ─────────────────────────────────────────────

  describe('response format', () => {
    it('should always include status, code, message, result, timestamp', () => {
      const { body } = catchAndGetResponse(filter, new Error('test'));

      expect(body).toHaveProperty('status');
      expect(body).toHaveProperty('code');
      expect(body).toHaveProperty('message');
      expect(body).toHaveProperty('result');
      expect(body).toHaveProperty('timestamp');
      expect(body.timestamp).toBeCloseTo(Date.now(), -2); // within ~100ms
    });
  });
});
