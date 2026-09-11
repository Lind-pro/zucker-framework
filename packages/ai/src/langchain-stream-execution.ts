import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { HumanMessage, SystemMessage, type UsageMetadata } from '@langchain/core/messages';
import { z } from 'zod';
import { jsonrepair } from 'jsonrepair';
import { extractJsonCandidate } from '@zucker-framework/common';
import {
  withStreamIdleTimeout,
  StreamIdleTimeoutError,
  deepStripNullBytes,
} from '@zucker-framework/core';
import { createAbortScope } from './abort-signal';
import {
  validateStructuredOutput,
  describeStructuredOutputFailure,
  StructuredOutputValidationError,
  StructuredOutputEmptyError,
} from './structured-output';

export interface LangChainStreamStats {
  chunkCount: number;
  elapsedMs: number;
}
export interface LangChainStreamOptions {
  signal?: AbortSignal;
  /** Omit to preserve a consumer's existing unbounded stream. */
  idleTimeoutMs?: number;
  idleError?: (idleMs: number) => Error;
  onFirstChunk?: (elapsedMs: number) => void;
  onComplete?: (stats: LangChainStreamStats) => void;
}

async function consumeStream<T>(
  open: (signal: AbortSignal) => Promise<AsyncIterable<T>>,
  consume: (chunk: T) => void,
  options: LangChainStreamOptions,
): Promise<LangChainStreamStats> {
  const startedAt = Date.now();
  const { controller, dispose } = createAbortScope(options.signal);
  let chunkCount = 0;
  try {
    const raw = await open(controller.signal);
    const stream =
      options.idleTimeoutMs === undefined
        ? raw
        : withStreamIdleTimeout(raw, options.idleTimeoutMs, {
            onIdle: () => controller.abort(),
            createError:
              options.idleError ?? ((ms) => new StreamIdleTimeoutError(`Stream idle for ${ms}ms`)),
          });
    for await (const chunk of stream) {
      consume(chunk);
      chunkCount++;
      if (chunkCount === 1) options.onFirstChunk?.(Date.now() - startedAt);
    }
  } finally {
    dispose();
  }
  const stats = { chunkCount, elapsedMs: Date.now() - startedAt };
  options.onComplete?.(stats);
  return stats;
}

export interface LangChainTextResult extends LangChainStreamStats {
  text: string;
  reasoningCharCount: number;
  /** Last usage-bearing chunk, preserving the model adapter's aggregation semantics. */
  usage?: UsageMetadata;
}
export interface LangChainInvocationOptions extends LangChainStreamOptions {
  model: BaseChatModel;
  systemPrompt: string;
  userPrompt: string;
  callbacks?: BaseCallbackHandler[];
}

export interface LangChainMessageInvocationOptions extends LangChainStreamOptions {
  model: BaseChatModel;
  messages: Parameters<BaseChatModel['stream']>[0];
  callbacks?: BaseCallbackHandler[];
  /** Defaults to true for compatibility with the prompt-based collector. */
  trim?: boolean;
}

/** Collect answer chunks separately from reasoning; no automatic retry or business empty-result policy. */
export async function collectLangChainText(
  options: LangChainInvocationOptions | LangChainMessageInvocationOptions,
): Promise<LangChainTextResult> {
  const chunks: string[] = [];
  let reasoningCharCount = 0;
  let usage: UsageMetadata | undefined;
  const stats = await consumeStream(
    (signal) =>
      options.model.stream(
        'messages' in options
          ? options.messages
          : [new SystemMessage(options.systemPrompt), new HumanMessage(options.userPrompt)],
        { signal, callbacks: options.callbacks },
      ),
    (chunk) => {
      if (typeof chunk.content === 'string' && chunk.content) chunks.push(chunk.content);
      if (chunk.usage_metadata) usage = chunk.usage_metadata;
      const reasoning = chunk.additional_kwargs?.reasoning_content;
      if (typeof reasoning === 'string') reasoningCharCount += reasoning.length;
    },
    options,
  );
  const text = chunks.join('');
  return {
    ...stats,
    text: 'trim' in options && options.trim === false ? text : text.trim(),
    reasoningCharCount,
    ...(usage ? { usage } : {}),
  };
}

export interface StructureRepairContext {
  error: unknown;
  paths: string[];
  previousOutput: string;
  schemaInstruction: string;
}
export interface LangChainStructuredOptions<T> extends LangChainInvocationOptions {
  schema: z.ZodType<T>;
  method: 'functionCalling' | 'jsonMode';
  /** Optional consumer-selected object key; omitted means strict root validation. */
  rootArrayField?: string;
  /** Explicit one-attempt recovery policy. Omitting this never calls a provider again. */
  repair?: (context: StructureRepairContext) => Promise<string>;
  onRepairJsonError?: (error: unknown) => void;
  onRepairSuccess?: () => void;
}

export function structuredSchemaInstruction(schema: z.ZodType): string {
  return `Return only a JSON value matching this schema. Do not return the schema itself.\n${JSON.stringify(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }))}`;
}

/** LangChain structured stream execution, local repair and schema transforms/defaults. */
export async function executeLangChainStructured<T>(
  options: LangChainStructuredOptions<T>,
): Promise<T> {
  const instruction = structuredSchemaInstruction(options.schema);
  const system =
    options.method === 'jsonMode'
      ? `${options.systemPrompt}\n\n${instruction}`
      : options.systemPrompt;
  const structured = options.model.withStructuredOutput(options.schema, { method: options.method });
  let result: unknown;
  try {
    await consumeStream(
      (signal) =>
        structured.stream([new SystemMessage(system), new HumanMessage(options.userPrompt)], {
          signal,
          callbacks: options.callbacks,
        }),
      (chunk) => {
        result = chunk;
      },
      options,
    );
  } catch (error) {
    // A stalled/cancelled connection is not a parser failure; never repair it.
    if (error instanceof StreamIdleTimeoutError || options.signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const parseFailure = ['Failed to parse', 'Unterminated', 'OUTPUT_PARSING_FAILURE'].some(
      (part) => message.includes(part),
    );
    if (!parseFailure || !options.repair) throw error;
    const parser = error as {
      llmOutput?: unknown;
      cause?: { issues?: Array<{ path?: unknown[] }> };
    };
    const paths =
      parser.cause?.issues
        ?.map((issue) => issue.path?.join('.'))
        .filter((path): path is string => Boolean(path))
        .slice(0, 12) ?? [];
    const raw = await options.repair({
      error,
      paths,
      previousOutput: typeof parser.llmOutput === 'string' ? parser.llmOutput.slice(0, 16000) : '',
      schemaInstruction: instruction,
    });
    const candidate = extractJsonCandidate(raw);
    let repaired: unknown;
    try {
      repaired = JSON.parse(jsonrepair(candidate.text));
    } catch (repairError) {
      options.onRepairJsonError?.(repairError);
      throw error;
    }
    const validated = validateStructuredOutput(options.schema, repaired, options.rootArrayField);
    if (!validated.success)
      throw new StructuredOutputValidationError(
        describeStructuredOutputFailure(repaired, validated.error.issues, candidate.truncated),
        validated.error.issues,
        'repair',
        { cause: error },
      );
    options.onRepairSuccess?.();
    return deepStripNullBytes(validated.data);
  }
  if (result === undefined) throw new StructuredOutputEmptyError();
  const validated = validateStructuredOutput(options.schema, result, options.rootArrayField);
  if (!validated.success)
    throw new StructuredOutputValidationError(
      describeStructuredOutputFailure(result, validated.error.issues, false),
      validated.error.issues,
      'direct',
    );
  return deepStripNullBytes(validated.data);
}
