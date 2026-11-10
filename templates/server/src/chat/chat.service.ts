import {
  BadRequestException, ConflictException, HttpException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException, type OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { NativeAIClient, type NativeChunk, type NativeMessage, type TokenUsage } from '@zucker-framework/ai';
import { AITaskInsufficientCreditsError } from '@zucker-framework/ai-tasks';
import { ApplicationDatabase, type ApplicationTransaction } from '../database';
import { JobsService } from '../jobs/jobs.service';
import { AIConnectionUnavailableError } from '../ai-connections/ai-connections.config';
import { AICatalogService } from '../ai-tasks/ai-catalog.service';
import { ChatCreditLedger, availableCredits } from '../ai-tasks/ai-credits';
import type { ChatPrice } from '../ai-tasks/ai.policy';

export const CHAT_OPTIONS = Symbol('CHAT_OPTIONS');
export interface ChatOptions {
  /** Upper bound of answer tokens per turn (the connection's own maxTokens still applies), default 4096. */
  maxOutputTokens: number;
  /** A STREAMING turn older than this is settled as FAILED with a full refund (crashed process), default 20 min. */
  staleAfterMs: number;
}
export function chatOptionsFromEnvironment(env: Readonly<Record<string, string | undefined>>): ChatOptions {
  const raw = env.CHAT_MAX_OUTPUT_TOKENS;
  const maxOutputTokens = raw === undefined || raw === '' ? 4096 : Number(raw);
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 16 || maxOutputTokens > 1_048_576) throw new Error('CHAT_MAX_OUTPUT_TOKENS must be 16..1048576');
  return { maxOutputTokens, staleAfterMs: 20 * 60_000 };
}

const MAX_CONTENT = 8000, MAX_TITLE = 120, HISTORY_MESSAGES = 40, HISTORY_CHARS = 32_000, MAX_REASONING = 32_000, MAX_ANSWER = 200_000;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/** `ceil(in/1000 × rateIn + out/1000 × rateOut)`, at least `minimum`; exact with rates of up to four decimals. */
export function chatCost(price: ChatPrice, usage: { input: number; output: number }): number {
  const scaled = (rate: number) => BigInt(Math.round(rate * 10_000));
  const numerator = BigInt(Math.max(0, usage.input)) * scaled(price.per1kInputTokens) + BigInt(Math.max(0, usage.output)) * scaled(price.per1kOutputTokens);
  const denominator = 10_000_000n;
  const cost = (numerator + denominator - 1n) / denominator;
  const capped = cost > 2_147_483_647n ? 2_147_483_647 : Number(cost);
  return Math.max(price.minimum, capped);
}

interface ChatRow { id: string; ownerId: string; title: string; providerId: string; model: string; messageCount: number; cost: number; createdAt: Date; updatedAt: Date }
interface MessageRow { id: string; role: 'user' | 'assistant'; parts: Array<{ type: string; text: string }> | string; status: string; providerId: string | null;
  model: string | null; inputTokens: number; outputTokens: number; cost: number; errorCode: string | null; createdAt: Date; completedAt: Date | null; seq: number }

export interface ChatTurnBody { content: string; providerId?: string; model?: string }
/** Minimal response surface used for SSE (Express response). */
export interface SseResponse {
  status(code: number): SseResponse;
  setHeader(name: string, value: string): void;
  flushHeaders?(): void;
  write(chunk: string): boolean;
  end(): void;
  json?(body: unknown): void;
  once(event: 'drain' | 'close', listener: () => void): void;
  on(event: 'close', listener: () => void): void;
  readonly writableEnded: boolean;
  readonly headersSent: boolean;
  destroyed?: boolean;
}

function view(chat: ChatRow) {
  return { id: chat.id, title: chat.title, providerId: chat.providerId, model: chat.model, messageCount: chat.messageCount,
    cost: chat.cost, createdAt: chat.createdAt, updatedAt: chat.updatedAt };
}
function parts(row: MessageRow): Array<{ type: string; text: string }> {
  const value = typeof row.parts === 'string' ? JSON.parse(row.parts) as MessageRow['parts'] : row.parts;
  return Array.isArray(value) ? value as Array<{ type: string; text: string }> : [];
}
function messageView(row: MessageRow) {
  const list = parts(row);
  return { id: row.id, role: row.role, content: list.filter(part => part.type === 'text').map(part => part.text).join(''),
    reasoning: list.find(part => part.type === 'reasoning')?.text ?? null, status: row.status, providerId: row.providerId, model: row.model,
    usage: { input: row.inputTokens, output: row.outputTokens }, cost: row.cost, errorCode: row.errorCode, createdAt: row.createdAt, completedAt: row.completedAt };
}

/**
 * Owner-scoped chat sessions with metered, streamed turns. A turn holds the policy `minimum` before the
 * provider is called; on completion the actual token cost is charged and the rest returned (one
 * transaction, settled exactly once by a status CAS on the assistant row). A provider error before
 * the first token returns the whole hold; a client disconnect aborts the provider call and settles the
 * partial answer once.
 */
@Injectable()
export class ChatService implements OnModuleInit {
  private readonly logger = new Logger(ChatService.name);
  private readonly credits: ChatCreditLedger;
  private lastStaleScan = 0;

  constructor(@Inject(DATABASE_ADAPTER) private readonly database: ApplicationDatabase, private readonly ai: NativeAIClient,
    private readonly catalog: AICatalogService, private readonly jobs: JobsService, @Inject(CHAT_OPTIONS) private readonly options: ChatOptions) {
    this.credits = new ChatCreditLedger(database);
  }

  onModuleInit(): void {
    this.jobs.registerWakeSource({ name: 'chat-stale-turns', runOnce: async () => {
      if (Date.now() - this.lastStaleScan < 60_000) return;
      this.lastStaleScan = Date.now();
      await this.settleStale();
    } });
  }

  private async pick(providerId: unknown, model: unknown) {
    if (providerId === undefined && model === undefined) {
      const entry = (await this.catalog.catalog('chat')).find(item => this.catalog.chatConnection(item.providerId));
      if (!entry) throw new ServiceUnavailableException({ code: 'AI_CHAT_UNAVAILABLE', message: 'No chat model is available' });
      return entry;
    }
    if (typeof providerId !== 'string' || typeof model !== 'string' || providerId.length > 64 || model.length > 128)
      throw new BadRequestException({ code: 'AI_CHAT_INVALID', message: 'providerId and model must be given together' });
    const entry = await this.catalog.offered('chat', providerId, model);
    if (!entry) throw new BadRequestException({ code: 'AI_MODEL_NOT_OFFERED', message: 'This model is not offered' });
    return entry;
  }

  async create(ownerId: string, body: unknown) {
    const input = body === undefined || body === null ? {} : body;
    if (typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['providerId', 'model', 'title'].includes(key)))
      throw new BadRequestException({ code: 'AI_CHAT_INVALID', message: 'Invalid chat request' });
    const fields = input as Record<string, unknown>;
    const title = fields.title === undefined ? '' : fields.title;
    if (typeof title !== 'string' || title.length > MAX_TITLE || CONTROL.test(title) || /[\r\n]/.test(title))
      throw new BadRequestException({ code: 'AI_CHAT_INVALID', message: 'Invalid title' });
    const entry = await this.pick(fields.providerId, fields.model);
    const now = new Date();
    const chat = { id: randomUUID(), ownerId, title: title.trim(), providerId: entry.providerId, model: entry.model, messageCount: 0, cost: 0, createdAt: now, updatedAt: now };
    await this.database.model('chats').create({ data: chat });
    return view(chat);
  }

  async list(ownerId: string, query: Record<string, unknown>) {
    if (Object.keys(query).some(key => key !== 'limit' && key !== 'before')) throw new BadRequestException('Unsupported chat query');
    const limit = query.limit === undefined ? 20 : Number(query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException('Invalid limit');
    let before: { t: Date; i: string } | undefined;
    if (query.before !== undefined) {
      try {
        const decoded = JSON.parse(Buffer.from(String(query.before), 'base64url').toString('utf8')) as { t?: unknown; i?: unknown };
        const t = new Date(String(decoded.t));
        if (typeof decoded.i !== 'string' || decoded.i.length > 64 || !Number.isFinite(t.getTime())) throw new Error();
        before = { t, i: decoded.i };
      } catch { throw new BadRequestException('Invalid cursor'); }
    }
    const rows = (await this.database.transaction(tx => tx.query<ChatRow>(
      `SELECT * FROM chats WHERE "ownerId"=$1 AND ($2::boolean OR ("updatedAt", id) < ($3, $4))
       ORDER BY "updatedAt" DESC, id DESC LIMIT $5`, [ownerId, !before, before?.t ?? new Date(0), before?.i ?? '', limit + 1]))).rows;
    const items = rows.slice(0, limit), last = items[items.length - 1];
    return { items: items.map(view),
      next: rows.length > limit && last ? Buffer.from(JSON.stringify({ t: new Date(last.updatedAt).toISOString(), i: last.id })).toString('base64url') : null };
  }

  private async owned(tx: ApplicationTransaction, ownerId: string, id: string, lock = false): Promise<ChatRow> {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException();
    const chat = (await tx.query<ChatRow>(`SELECT * FROM chats WHERE id=$1 AND "ownerId"=$2${lock ? ' FOR UPDATE' : ''}`, [id, ownerId])).rows[0];
    if (!chat) throw new NotFoundException();
    return chat;
  }

  async get(ownerId: string, id: string) {
    return this.database.transaction(async tx => {
      const chat = await this.owned(tx, ownerId, id);
      const messages = (await tx.query<MessageRow>(
        `SELECT * FROM (SELECT * FROM chat_messages WHERE "chatId"=$1 ORDER BY seq DESC LIMIT 200) AS recent ORDER BY seq ASC`, [id])).rows;
      return { ...view(chat), messages: messages.map(messageView) };
    });
  }

  async delete(ownerId: string, id: string) {
    await this.database.transaction(async tx => {
      await this.owned(tx, ownerId, id, true);
      // A streaming turn still owns a credit hold; it must settle before its rows can go.
      const busy = await tx.query('SELECT 1 FROM chat_messages WHERE "chatId"=$1 AND status=\'STREAMING\' LIMIT 1', [id]);
      if (busy.rows.length) throw new ConflictException({ code: 'AI_CHAT_BUSY', message: 'Wait for the current answer to finish' });
      await tx.query('DELETE FROM chats WHERE id=$1 AND "ownerId"=$2', [id, ownerId]);
    });
    return { deleted: true };
  }

  parseTurn(body: unknown): ChatTurnBody {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException({ code: 'AI_CHAT_INVALID', message: 'Invalid message' });
    const input = body as Record<string, unknown>;
    if (Object.keys(input).some(key => !['content', 'providerId', 'model', 'webSearch'].includes(key)))
      throw new BadRequestException({ code: 'AI_CHAT_INVALID', message: 'Unsupported message field' });
    // No search tool is registered in this template: refuse rather than silently answering without it.
    if (input.webSearch !== undefined && input.webSearch !== false)
      throw new BadRequestException({ code: 'AI_TOOL_UNAVAILABLE', message: 'Web search is not available' });
    if (typeof input.content !== 'string' || !input.content.trim() || input.content.length > MAX_CONTENT || CONTROL.test(input.content))
      throw new BadRequestException({ code: 'AI_CHAT_INVALID', message: `Message must be 1-${MAX_CONTENT} characters` });
    if ((input.providerId === undefined) !== (input.model === undefined))
      throw new BadRequestException({ code: 'AI_CHAT_INVALID', message: 'providerId and model must be given together' });
    return { content: input.content, ...(input.providerId !== undefined ? { providerId: input.providerId as string, model: input.model as string } : {}) };
  }

  /**
   * Starts a metered turn and streams it as SSE. Errors before the first token answer with a normal
   * JSON status (402 insufficient credits, 404, 409 busy, 502/503 provider); afterwards they arrive as
   * an `error` event. The response is written directly (raw SSE, outside the JSON envelope).
   */
  async stream(ownerId: string, chatId: string, body: unknown, res: SseResponse): Promise<void> {
    const turn = this.parseTurn(body);
    const choice = turn.providerId !== undefined ? await this.pick(turn.providerId, turn.model) : undefined;
    const price = await this.catalog.chatPrice();
    const userMessageId = randomUUID(), messageId = randomUUID();
    let prepared: { chat: ChatRow; history: NativeMessage[]; held: number; holdId: string | null; maxTokens: number; route: string };
    try {
      prepared = await this.database.transaction(async tx => {
        const chat = await this.owned(tx, ownerId, chatId, true);
        const providerId = choice?.providerId ?? chat.providerId, model = choice?.model ?? chat.model;
        if (!choice && !(await this.catalog.offered('chat', providerId, model)))
          throw new BadRequestException({ code: 'AI_MODEL_NOT_OFFERED', message: 'This chat model is no longer offered; choose another' });
        const connection = this.catalog.chatConnection(providerId);
        if (!connection) throw new ServiceUnavailableException({ code: 'AI_PROVIDER_UNAVAILABLE', message: 'This chat model is not available right now' });
        const busy = await tx.query('SELECT 1 FROM chat_messages WHERE "chatId"=$1 AND status=\'STREAMING\' LIMIT 1', [chatId]);
        if (busy.rows.length) throw new ConflictException({ code: 'AI_CHAT_BUSY', message: 'Wait for the current answer to finish' });
        const prior = (await tx.query<MessageRow>(
          `SELECT * FROM chat_messages WHERE "chatId"=$1 AND status='COMPLETE' ORDER BY seq DESC LIMIT $2`, [chatId, HISTORY_MESSAGES - 1])).rows;
        const history: NativeMessage[] = [{ role: 'user', content: turn.content }];
        let chars = turn.content.length;
        for (const row of prior) {
          const text = messageView(row).content;
          if (!text || chars + text.length > HISTORY_CHARS) break;
          chars += text.length;
          history.unshift({ role: row.role, content: text });
        }
        // Answer length the wallet can pay for (balance before the hold covers the hold itself).
        const budget = await availableCredits(tx, ownerId);
        if (budget < price.minimum) throw new AITaskInsufficientCreditsError(price.minimum, budget);
        const inputCost = BigInt(estimateTokens(history.map(message => message.content).join(''))) * BigInt(Math.round(price.per1kInputTokens * 10_000));
        const outputRate = BigInt(Math.round(price.per1kOutputTokens * 10_000));
        let maxTokens = Math.min(this.options.maxOutputTokens, connection.maxTokens ?? this.options.maxOutputTokens);
        if (outputRate > 0n) {
          const remaining = BigInt(budget) * 10_000_000n - inputCost;
          const affordable = remaining > 0n ? remaining / outputRate : 0n;
          if (affordable < 16n) throw new AITaskInsufficientCreditsError(price.minimum + 1, budget);
          if (affordable < BigInt(maxTokens)) maxTokens = Number(affordable);
        }
        const holdId = price.minimum > 0 ? `chat-hold:${messageId}` : null;
        if (holdId) await this.credits.hold(tx, { holdId, ownerId, amount: price.minimum, messageId });
        const now = new Date();
        await tx.query(`INSERT INTO chat_messages (id,"chatId","ownerId",seq,role,parts,status,"createdAt","updatedAt","completedAt")
          VALUES ($1,$2,$3,$4,'user',$5::jsonb,'COMPLETE',$6,$6,$6)`,
        [userMessageId, chatId, ownerId, chat.messageCount, JSON.stringify([{ type: 'text', text: turn.content }]), now]);
        await tx.query(`INSERT INTO chat_messages (id,"chatId","ownerId",seq,role,parts,"providerId",model,status,"holdId","holdAmount","createdAt","updatedAt")
          VALUES ($1,$2,$3,$4,'assistant','[]'::jsonb,$5,$6,'STREAMING',$7,$8,$9,$9)`,
        [messageId, chatId, ownerId, chat.messageCount + 1, providerId, model, holdId, holdId ? price.minimum : 0, now]);
        const title = chat.title || turn.content.replace(/\s+/g, ' ').trim().slice(0, 60);
        await tx.query(`UPDATE chats SET "messageCount"="messageCount"+2, "updatedAt"=$2, title=$3, "providerId"=$4, model=$5 WHERE id=$1`,
          [chatId, now, title, providerId, model]);
        return { chat: { ...chat, providerId, model }, history, held: holdId ? price.minimum : 0, holdId, maxTokens, route: connection.definition.route };
      });
    } catch (error) {
      if (error instanceof AITaskInsufficientCreditsError)
        throw new HttpException({ code: error.code, message: 'Insufficient credits', reason: error.code, details: { required: error.required, available: error.available ?? null } }, 402);
      throw error;
    }

    const controller = new AbortController();
    let clientGone = false;
    res.on('close', () => { if (!res.writableEnded) { clientGone = true; controller.abort(new Error('Client disconnected')); } });
    let opened = false, answer = '', reasoning = '', usage: TokenUsage | undefined;
    const send = async (event: string, data: unknown) => {
      if (clientGone || res.writableEnded) return;
      if (!res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) && !clientGone)
        await new Promise<void>(resolve => { res.once('drain', resolve); res.once('close', resolve); });
    };
    const open = async () => {
      if (opened) return;
      opened = true;
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      // no-transform: compressing proxies (Next's `compress`, the `compression` middleware, CDNs) must
      // not gzip-buffer the stream; without it the browser receives every event at once at the end.
      res.setHeader('Cache-Control', 'private, no-store, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.flushHeaders?.();
      await send('start', { chatId, messageId, userMessageId, providerId: prepared.chat.providerId, model: prepared.chat.model, held: prepared.held });
    };
    const onChunk = async (chunk: NativeChunk) => {
      if (chunk.usage) usage = chunk.usage;
      if (chunk.reasoning) {
        await open();
        if (reasoning.length < MAX_REASONING) reasoning += chunk.reasoning.slice(0, MAX_REASONING - reasoning.length);
        await send('reasoning', { text: chunk.reasoning });
      }
      if (chunk.content) {
        await open();
        if (answer.length + chunk.content.length > MAX_ANSWER) throw new Error('Answer exceeds the stored size');
        answer += chunk.content;
        await send('delta', { text: chunk.content });
      }
    };

    let status: 'COMPLETE' | 'FAILED' | 'ABORTED' = 'COMPLETE', errorCode: string | null = null;
    try {
      const result = await this.ai.stream(prepared.route, { messages: prepared.history, maxTokens: prepared.maxTokens },
        { modelId: prepared.chat.model, signal: controller.signal, onChunk, context: 'chat' });
      usage = result.usage ?? usage;
    } catch (error) {
      status = clientGone ? 'ABORTED' : 'FAILED';
      errorCode = clientGone ? 'AI_CHAT_ABORTED' : error instanceof AIConnectionUnavailableError ? 'AI_PROVIDER_UNAVAILABLE' : 'AI_PROVIDER_FAILED';
      if (!clientGone) this.logger.warn(`Chat turn failed (${errorCode}) for message ${messageId}`);
    }

    // Charge: full turn = reported usage (estimated when the provider sent none); interrupted turn =
    // what was delivered; nothing delivered = nothing charged (the hold is returned whole).
    const delivered = answer.length > 0 || reasoning.length > 0;
    const promptTokens = estimateTokens(prepared.history.map(message => message.content).join(''));
    const metered = status === 'COMPLETE' && usage ? { input: usage.input, output: usage.output }
      : { input: usage?.input ?? promptTokens, output: usage?.output ?? estimateTokens(answer + reasoning) };
    const cost = status === 'COMPLETE' || delivered ? chatCost(price, metered) : 0;
    let charged = 0;
    try {
      charged = await this.settle(ownerId, chatId, messageId, prepared.holdId, {
        status, cost, errorCode, usage: status === 'COMPLETE' || delivered ? metered : { input: 0, output: 0 },
        parts: [...(answer ? [{ type: 'text', text: answer }] : []), ...(reasoning ? [{ type: 'reasoning', text: reasoning }] : [])],
      }) ?? 0;
    } catch {
      // The hold stays HELD and the row STREAMING; the stale-turn reconciler returns it later.
      this.logger.error(`Chat settlement failed for message ${messageId}; left for reconciliation`);
      if (!opened && !clientGone) throw new ServiceUnavailableException({ code: 'AI_CHAT_SETTLEMENT_PENDING', message: 'The answer could not be recorded' });
      if (!res.writableEnded) { await send('error', { code: 'AI_CHAT_SETTLEMENT_PENDING', message: 'The answer could not be recorded' }); res.end(); }
      return;
    }

    if (clientGone) { if (!res.writableEnded) res.end(); return; }
    if (!opened) {
      // Nothing was streamed: answer with an ordinary JSON error (the hold was returned above).
      if (status !== 'COMPLETE') {
        throw errorCode === 'AI_PROVIDER_UNAVAILABLE'
          ? new ServiceUnavailableException({ code: errorCode, message: 'The chat model is not available right now' })
          : new HttpException({ code: errorCode, message: 'The chat model could not answer' }, 502);
      }
      await open();
    }
    if (status === 'COMPLETE') await send('done', { messageId, usage: metered, cost: charged });
    else await send('error', { code: errorCode, message: 'The answer was interrupted', messageId, usage: metered, cost: charged });
    res.end();
  }

  /** Exactly-once settlement: status CAS on the STREAMING row, ledger and chat totals in one transaction. Null when already settled. */
  private async settle(ownerId: string, chatId: string, messageId: string, holdId: string | null, outcome: {
    status: 'COMPLETE' | 'FAILED' | 'ABORTED'; cost: number; errorCode: string | null; usage: { input: number; output: number }; parts: Array<{ type: string; text: string }>;
  }): Promise<number | null> {
    return this.database.transaction(async tx => {
      const now = new Date();
      const claimed = await tx.query(`UPDATE chat_messages SET status=$2, parts=$3::jsonb, "inputTokens"=$4, "outputTokens"=$5, "errorCode"=$6,
          "updatedAt"=$7, "completedAt"=$7 WHERE id=$1 AND status='STREAMING' RETURNING id`,
      [messageId, outcome.status, JSON.stringify(outcome.parts), Math.max(0, Math.trunc(outcome.usage.input)), Math.max(0, Math.trunc(outcome.usage.output)), outcome.errorCode, now]);
      if (!claimed.rows.length) return null;
      const charged = await this.credits.settle(tx, { holdId, ownerId, messageId, cost: outcome.cost });
      await tx.query('UPDATE chat_messages SET cost=$2 WHERE id=$1', [messageId, charged]);
      await tx.query('UPDATE chats SET cost=cost+$2, "updatedAt"=$3 WHERE id=$1', [chatId, charged, now]);
      return charged;
    });
  }

  /** Returns holds of turns whose process died mid-stream (no charge: the delivered amount is unknown). */
  async settleStale(limit = 50): Promise<number> {
    const stale = (await this.database.transaction(tx => tx.query<{ id: string; chatId: string; ownerId: string; holdId: string | null }>(
      `SELECT id, "chatId", "ownerId", "holdId" FROM chat_messages WHERE status='STREAMING' AND "updatedAt" < $1 ORDER BY "updatedAt" LIMIT $2`,
      [new Date(Date.now() - this.options.staleAfterMs), limit]))).rows;
    let settled = 0;
    for (const row of stale) {
      try {
        if (await this.settle(row.ownerId, row.chatId, row.id, row.holdId, { status: 'FAILED', cost: 0, errorCode: 'AI_CHAT_INTERRUPTED', usage: { input: 0, output: 0 }, parts: [] }) !== null) settled += 1;
      } catch { this.logger.warn(`Stale chat turn ${row.id} could not be settled yet`); }
    }
    return settled;
  }
}
