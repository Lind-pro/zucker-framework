import { sanitizeAIObserverError, sanitizeAIObserverMetadata } from './observer-sanitizer';

describe('AI observer sanitization', () => {
  it('redacts sensitive AI and identity fields while preserving operational ids', () => {
    expect(
      sanitizeAIObserverMetadata({
        taskId: 'task-1',
        model: 'gpt-image-2',
        prompt: 'draw the invention',
        claims: ['claim text'],
        nested: {
          technicalDescription: 'secret disclosure',
          providerRequestId: 'request-1',
        },
        userEmail: 'user@example.com',
      }),
    ).toEqual({
      taskId: 'task-1',
      model: 'gpt-image-2',
      prompt: '[REDACTED]',
      claims: '[REDACTED]',
      nested: {
        technicalDescription: '[REDACTED]',
        providerRequestId: 'request-1',
      },
      userEmail: '[REDACTED]',
    });
  });

  it('truncates long strings in metadata and observer errors', () => {
    const longValue = 'x'.repeat(400);
    const metadata = sanitizeAIObserverMetadata({ note: longValue });
    const error = sanitizeAIObserverError(new Error(longValue));

    expect(String(metadata?.note)).toHaveLength(283);
    expect(error.message).toHaveLength(280);
  });
});
