import { describe, expect, it } from 'vitest';
import {
  ERROR_REPORTER,
  NoopErrorReporter,
  type ErrorContext,
  type ErrorReporter,
} from './error-reporter';

describe('ErrorReporter', () => {
  it('uses a stable global injection token', () => {
    expect(ERROR_REPORTER).toBe(Symbol.for('@zucker-framework/monitoring/error-reporter'));
  });

  it('provides a side-effect-free disabled implementation', () => {
    const reporter: ErrorReporter = new NoopErrorReporter();
    const context: ErrorContext = {
      requestId: 'request-1',
      userId: 'user-1',
      resourceId: 'resource-1',
      operation: 'generate',
    };

    expect(() => reporter.captureException(new Error('test'), context)).not.toThrow();
    expect(() => reporter.captureMessage('test', context)).not.toThrow();
    expect(() => reporter.setUser({ id: 'user-1' })).not.toThrow();
    expect(() => reporter.setUser(null)).not.toThrow();
  });
});
