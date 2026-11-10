import type { ChatMessage, ChatUsage } from './types';

/**
 * Pure state machine for one chat transcript and its streaming turn. SSE events arrive in the
 * order `start`, `reasoning`*, `delta`*, then exactly one of `done` | `error`; anything else, or
 * anything outside a turn, is ignored. No React or app imports so node tests can load it.
 */
export interface ChatTurnState {
  messages: ChatMessage[];
  /** Ids of the user/assistant pair of the running turn (local ids until `start` renames them). */
  pending: { userId: string; assistantId: string } | null;
  /** A failure explained above the composer (an `AI_*` code or a page-level reason). */
  error: string | null;
  /** Credits charged by the last settled turn. */
  lastCost: number | null;
}

export type ChatAction =
  /** `keepError`: a reload after a refused turn must not hide why the turn was refused. */
  | { type: 'load'; messages: ChatMessage[]; keepError?: boolean }
  | { type: 'send'; content: string; localId: string }
  | { type: 'event'; event: string; data: unknown }
  /** The user pressed stop (the fetch was aborted). */
  | { type: 'stopped' }
  /** The stream closed without `done`/`error` (network loss, idle timeout). */
  | { type: 'ended' }
  /** The server refused the turn before streaming (JSON error): nothing of it is shown as sent. */
  | { type: 'rejected'; reason: string }
  | { type: 'dismiss' };

export const initialChatState: ChatTurnState = { messages: [], pending: null, error: null, lastCost: null };

export function isStreaming(state: ChatTurnState): boolean {
  return state.pending !== null;
}

/** SSE `data:` lines are JSON objects; anything else is treated as an empty payload. */
export function parseSseData(data: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(data);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
function usageOf(value: unknown): ChatUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = num((value as { input?: unknown }).input),
    output = num((value as { output?: unknown }).output);
  return input !== undefined && output !== undefined ? { input, output } : undefined;
}

function updateAssistant(state: ChatTurnState, update: (message: ChatMessage) => ChatMessage): ChatMessage[] {
  const id = state.pending?.assistantId;
  return state.messages.map((message) => (message.id === id ? update(message) : message));
}

function settle(state: ChatTurnState, update: (message: ChatMessage) => ChatMessage, extra: Partial<ChatTurnState> = {}): ChatTurnState {
  return { ...state, messages: updateAssistant(state, update), pending: null, ...extra };
}

export function chatReducer(state: ChatTurnState, action: ChatAction): ChatTurnState {
  switch (action.type) {
    case 'load':
      return { ...initialChatState, messages: action.messages, error: action.keepError ? state.error : initialChatState.error };
    case 'send': {
      if (state.pending) return state;
      const userId = `local-user-${action.localId}`,
        assistantId = `local-assistant-${action.localId}`;
      return {
        ...state,
        error: null,
        pending: { userId, assistantId },
        messages: [
          ...state.messages,
          { id: userId, role: 'user', content: action.content, reasoning: null, status: 'COMPLETE' },
          { id: assistantId, role: 'assistant', content: '', reasoning: null, status: 'STREAMING' },
        ],
      };
    }
    case 'event':
      return applyEvent(state, action.event, action.data);
    case 'stopped':
      if (!state.pending) return state;
      return settle(state, (message) => ({ ...message, status: 'ABORTED', errorCode: 'AI_CHAT_ABORTED' }));
    case 'ended':
      if (!state.pending) return state;
      return settle(state, (message) => ({ ...message, status: 'FAILED', errorCode: 'AI_CHAT_INTERRUPTED' }), {
        error: 'AI_CHAT_INTERRUPTED',
      });
    case 'rejected': {
      if (!state.pending) return { ...state, error: action.reason };
      const { userId, assistantId } = state.pending;
      return {
        ...state,
        pending: null,
        error: action.reason,
        messages: state.messages.filter((message) => message.id !== userId && message.id !== assistantId),
      };
    }
    case 'dismiss':
      return { ...state, error: null };
    default:
      return state;
  }
}

function applyEvent(state: ChatTurnState, event: string, data: unknown): ChatTurnState {
  if (!state.pending) return state;
  const payload = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  switch (event) {
    case 'start': {
      const messageId = str(payload.messageId),
        userMessageId = str(payload.userMessageId);
      if (!messageId || !userMessageId) return state;
      const { userId, assistantId } = state.pending;
      return {
        ...state,
        pending: { userId: userMessageId, assistantId: messageId },
        messages: state.messages.map((message) =>
          message.id === userId
            ? { ...message, id: userMessageId }
            : message.id === assistantId
              ? { ...message, id: messageId, providerId: str(payload.providerId) ?? null, model: str(payload.model) ?? null }
              : message,
        ),
      };
    }
    case 'reasoning': {
      const text = str(payload.text);
      if (!text) return state;
      return { ...state, messages: updateAssistant(state, (message) => ({ ...message, reasoning: (message.reasoning ?? '') + text })) };
    }
    case 'delta': {
      const text = str(payload.text);
      if (!text) return state;
      return { ...state, messages: updateAssistant(state, (message) => ({ ...message, content: message.content + text })) };
    }
    case 'done': {
      const id = str(payload.messageId);
      if (id && id !== state.pending.assistantId) return state;
      const cost = num(payload.cost) ?? 0;
      return settle(
        state,
        (message) => ({ ...message, status: 'COMPLETE', cost, usage: usageOf(payload.usage) ?? null, errorCode: null }),
        { lastCost: cost },
      );
    }
    case 'error': {
      const id = str(payload.messageId);
      if (id && id !== state.pending.assistantId) return state;
      const code = str(payload.code) ?? 'AI_PROVIDER_FAILED';
      const cost = num(payload.cost) ?? 0;
      return settle(
        state,
        (message) => ({
          ...message,
          status: code === 'AI_CHAT_ABORTED' ? 'ABORTED' : 'FAILED',
          errorCode: code,
          cost,
          usage: usageOf(payload.usage) ?? null,
        }),
        { error: code, lastCost: cost },
      );
    }
    default:
      return state;
  }
}
