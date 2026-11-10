import { httpClient } from '@/lib/http-client';
import type { ChatDetail, ChatPage, ChatSummary } from './types';

const id = (value: string) => encodeURIComponent(value);
const quiet = { _hideError: true } as const;

export const chatApi = {
  list: (query: { limit?: number; before?: string } = {}) => httpClient.get<ChatPage>('/chat', query, quiet),
  get: (chatId: string, signal?: AbortSignal) => httpClient.get<ChatDetail>(`/chat/${id(chatId)}`, undefined, { ...quiet, signal }),
  create: (body: { providerId?: string; model?: string }) => httpClient.post<ChatSummary>('/chat', body, undefined, quiet),
  remove: (chatId: string) => httpClient.delete<{ deleted: boolean }>(`/chat/${id(chatId)}`, undefined, quiet),
  /**
   * Starts a turn. Resolves with the open SSE response; a refusal before streaming (400/402/404/
   * 409/502/503) rejects with `status` set. Aborting `signal` closes the stream, which the server
   * treats as a stop: it settles what was delivered.
   */
  send: (chatId: string, body: { content: string; providerId?: string; model?: string }, signal: AbortSignal) =>
    httpClient.fetchStream(`/chat/${id(chatId)}/messages`, {
      method: 'POST',
      body,
      headers: { Accept: 'text/event-stream' },
      signal,
    }),
};
