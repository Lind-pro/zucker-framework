import { AIErrorType } from './ai-provider.interface';
import { AICallAbortedError, AICallTimeoutError, classifyAIError } from './ai-call-errors';

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
