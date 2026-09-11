import { expect, it, vi } from 'vitest';
import { LangChainCallObserver } from './langchain-call-observer';
it('normalizes provider usage without forwarding prompts or generated content', async () => {
  const onSuccess = vi.fn();
  const observer = new LangChainCallObserver({ onSuccess, onError: vi.fn() });
  await observer.handleLLMStart({} as never, ['private prompt'], 'r');
  await observer.handleLLMEnd(
    {
      generations: [[{ text: 'private result' }]],
      llmOutput: { usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } },
    },
    'r',
  );
  expect(onSuccess).toHaveBeenCalledWith(
    expect.objectContaining({
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      contentLength: 14,
    }),
  );
  expect(JSON.stringify(onSuccess.mock.calls)).not.toContain('private');
});
