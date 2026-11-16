import { AITaskValidationError } from './errors';
import { AI_TASK_KINDS, type AITaskInput, type AITaskKind, type AITaskOptionValue, type SubmitAITaskCommand } from './types';

export interface AITaskInputLimits {
  /** Default 4000 characters. */
  maxPromptLength?: number;
  /** Serialized size of `options` + `references`, default 8192 bytes. */
  maxInputBytes?: number;
  /** Default 32 option keys. */
  maxOptions?: number;
  /** Default 4 references. */
  maxReferences?: number;
}

/**
 * Keys that select credentials, endpoints, transport or the model. They come from the server-side
 * provider resolver only; a caller that sends them is refused rather than silently stripped.
 */
const FORBIDDEN_OPTION_KEYS = new Set([
  'apikey', 'api_key', 'baseurl', 'base_url', 'proxyurl', 'proxy_url', 'callbackurl', 'callback_url',
  'modelid', 'model', 'signal', 'timeoutms', 'headers', 'endpoint', 'url', 'webhook', 'webhookurl',
  'clientrequestid',
  '__proto__', 'constructor', 'prototype',
]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
const OWNER = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,190}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,128}$/;
const OPTION_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const MAX_CREDIT_AMOUNT = 2_147_483_647;

export function isAITaskKind(value: unknown): value is AITaskKind {
  return typeof value === 'string' && (AI_TASK_KINDS as readonly string[]).includes(value);
}

function optionValue(value: unknown): value is AITaskOptionValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return Array.isArray(value) && value.length <= 32 && value.every((item) => typeof item === 'string' && item.length <= 200);
}

/** Validates and snapshots a submit command. Exact keys only (unknown keys are refused). */
export function validateSubmitCommand(command: SubmitAITaskCommand, limits: AITaskInputLimits = {}): SubmitAITaskCommand {
  if (!command || typeof command !== 'object') throw new AITaskValidationError('command');
  const allowed = new Set(['ownerId', 'kind', 'providerId', 'model', 'input', 'idempotencyKey', 'cost']);
  if (Object.keys(command).some((key) => !allowed.has(key))) throw new AITaskValidationError('command');
  if (typeof command.ownerId !== 'string' || !OWNER.test(command.ownerId)) throw new AITaskValidationError('ownerId');
  if (!isAITaskKind(command.kind)) throw new AITaskValidationError('kind');
  if (typeof command.providerId !== 'string' || !IDENTIFIER.test(command.providerId)) throw new AITaskValidationError('providerId');
  if (typeof command.model !== 'string' || !IDENTIFIER.test(command.model)) throw new AITaskValidationError('model');
  if (typeof command.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(command.idempotencyKey))
    throw new AITaskValidationError('idempotencyKey');
  if (command.cost !== undefined && (!Number.isSafeInteger(command.cost) || command.cost < 0 || command.cost > MAX_CREDIT_AMOUNT))
    throw new AITaskValidationError('cost');
  return {
    ownerId: command.ownerId,
    kind: command.kind,
    providerId: command.providerId,
    model: command.model,
    idempotencyKey: command.idempotencyKey,
    input: validateInput(command.input, limits),
    ...(command.cost === undefined ? {} : { cost: command.cost }),
  };
}

export function validateInput(input: AITaskInput, limits: AITaskInputLimits = {}): AITaskInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AITaskValidationError('input');
  if (Object.keys(input).some((key) => key !== 'prompt' && key !== 'options' && key !== 'references'))
    throw new AITaskValidationError('input');
  const maxPrompt = limits.maxPromptLength ?? 4000;
  if (typeof input.prompt !== 'string') throw new AITaskValidationError('prompt');
  const prompt = input.prompt.trim();
  // Control characters other than tab/newline have no place in a prompt and break log/CSV views.
  if (!prompt || prompt.length > maxPrompt || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(prompt))
    throw new AITaskValidationError('prompt');

  const result: { prompt: string; options?: Record<string, AITaskOptionValue>; references?: string[] } = { prompt };
  if (input.options !== undefined) {
    if (!input.options || typeof input.options !== 'object' || Array.isArray(input.options)) throw new AITaskValidationError('options');
    const entries = Object.entries(input.options);
    if (entries.length > (limits.maxOptions ?? 32)) throw new AITaskValidationError('options');
    const options: Record<string, AITaskOptionValue> = {};
    for (const [key, value] of entries) {
      if (!OPTION_KEY.test(key) || FORBIDDEN_OPTION_KEYS.has(key.toLowerCase()) || !optionValue(value))
        throw new AITaskValidationError(`options.${OPTION_KEY.test(key) ? key : '?'}`);
      if (typeof value === 'string' && value.length > 2000) throw new AITaskValidationError(`options.${key}`);
      options[key] = Array.isArray(value) ? [...value] : value;
    }
    result.options = options;
  }
  if (input.references !== undefined) {
    if (!Array.isArray(input.references) || input.references.length > (limits.maxReferences ?? 4)
      || input.references.some((reference) => typeof reference !== 'string' || !REFERENCE.test(reference)))
      throw new AITaskValidationError('references');
    result.references = [...new Set(input.references)];
  }
  const size = Buffer.byteLength(JSON.stringify({ options: result.options, references: result.references }));
  if (size > (limits.maxInputBytes ?? 8192)) throw new AITaskValidationError('input');
  return result;
}

export function validateCost(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_CREDIT_AMOUNT)
    throw new RangeError('AICostResolver must return an integer between 0 and 2147483647');
  return value as number;
}
