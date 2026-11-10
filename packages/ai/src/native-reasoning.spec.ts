import { describe, expect, it } from 'vitest';
import type OpenAI from 'openai';
import type Anthropic from '@anthropic-ai/sdk';
import type { GoogleGenAI } from '@google/genai';
import { anthropicNativeModel, geminiNativeModel, openAINativeModel } from './native-providers';
import type { NativeChunk } from './native-port';

const config = { apiKey: 'synthetic', modelId: 'm', maxTokens: 64 };
const request = { messages: [{ role: 'user' as const, content: 'q' }], maxTokens: 64 };
const iterate = (items: unknown[]) => (async function* () { yield* items; })();
const collect = async (stream: AsyncIterable<NativeChunk>) => { const out: NativeChunk[] = []; for await (const c of stream) out.push(c); return out; };

describe('native reasoning deltas', () => {
  it('maps OpenAI-compatible reasoning_content separately from content', async () => {
    const client = { chat: { completions: { create: async () => iterate([
      { choices: [{ delta: { reasoning_content: 'think' } }] },
      { choices: [{ delta: { content: 'answer' } }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
    ]) } } } as unknown as OpenAI;
    const chunks = await collect(await openAINativeModel(client, { ...config, providerId: 'deepseek' }).stream(request, new AbortController().signal));
    expect(chunks[0]).toMatchObject({ content: '', reasoning: 'think' });
    expect(chunks[1]).not.toHaveProperty('reasoning');
    expect(chunks[1]).toMatchObject({ content: 'answer' });
  });

  it('maps Anthropic thinking_delta to reasoning', async () => {
    const client = { messages: { create: async () => iterate([
      { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } },
    ]) } } as unknown as Anthropic;
    const chunks = await collect(await anthropicNativeModel(client, config).stream({ ...request, reasoning: { budgetTokens: 32 } }, new AbortController().signal));
    expect(chunks.slice(1)).toEqual([{ reasoning: 'hmm' }, { content: 'ok' }]);
  });

  it('maps Gemini thought parts to reasoning and keeps them out of content', async () => {
    const chunk = { text: 'ok', candidates: [{ content: { parts: [{ text: 'idea', thought: true }, { text: 'ok' }] } }] };
    const client = { models: { generateContentStream: async () => iterate([chunk]) } } as unknown as GoogleGenAI;
    const [first] = await collect(await geminiNativeModel(client, config).stream(request, new AbortController().signal));
    expect(first).toMatchObject({ content: 'ok', reasoning: 'idea' });
  });
});
