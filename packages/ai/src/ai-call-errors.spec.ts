import { AIErrorType } from './ai-provider.interface';
import {
  AICallAbortedError,
  AICallTimeoutError,
  classifyAIError,
  classifyAICallOutcome,
} from './ai-call-errors';

describe('classifyAIError', () => {
  it.each([
    [new AICallTimeoutError(1_000), AIErrorType.TIMEOUT, false],
    [new AICallAbortedError(), AIErrorType.CANCELLED, false],
    [Object.assign(new Error('unauthorized'), { status: 401 }), AIErrorType.AUTH, false],
    [Object.assign(new Error('rate limited'), { status: 429 }), AIErrorType.RATE_LIMIT, true],
    [
      Object.assign(new Error('provider unavailable'), { status: 503 }),
      AIErrorType.SERVER_ERROR,
      true,
    ],
    [Object.assign(new Error('bad request'), { status: 400 }), AIErrorType.INVALID_REQUEST, false],
    [new Error('socket hang up'), AIErrorType.NETWORK, true],
    [new Error('content policy rejection'), AIErrorType.CONTENT_POLICY, false],
  ])('classifies %s as %s', (error, type, retryable) => {
    expect(classifyAIError(error)).toEqual({ type, retryable });
  });
});

describe('AI diagnostic outcomes', () => {
  it.each([
    [Object.assign(new Error('request stopped'), { name: 'AbortError' }), 'cancelled'],
    [new Error('Request aborted'), 'cancelled'],
    [new Error('Request cancelled after timeout'), 'cancelled'],
    [new Error('Connection timeout'), 'timeout'],
    [new Error('Request timed out'), 'timeout'],
    [new Error('Provider unavailable'), 'error'],
    [new AICallTimeoutError(100), 'timeout'],
    [new AICallAbortedError(), 'cancelled'],
  ])('maps %s to the logging outcome %s', (error, expected) => {
    expect(classifyAICallOutcome(error as Error)).toBe(expected);
  });

  it('does not silently change the existing retry classification for untyped errors', () => {
    const error = new Error('Connection timeout');
    expect(classifyAICallOutcome(error)).toBe('timeout');
    expect(classifyAIError(error)).toEqual({ type: AIErrorType.UNKNOWN, retryable: true });
  });
});
