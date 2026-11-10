import { Readable } from 'node:stream';
import { BadRequestException, HttpException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException, type OnModuleInit } from '@nestjs/common';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import {
  AI_OUTPUT_EXTENSIONS,
  AITaskCostChangedError,
  AITaskError,
  AITaskIdempotencyConflictError,
  AITaskInsufficientCreditsError,
  AITaskOutputRejectedError,
  AITaskService,
  AITaskValidationError,
  isAITaskKind,
  type AITaskKind,
  type AITaskOptionValue,
  type AITaskPollingOptions,
  type AITaskView,
  type OutputStorePort,
} from '@zucker-framework/ai-tasks';
import type { TaskStatus } from '@zucker-framework/task';
import { ApplicationDatabase, type ApplicationTransaction } from '../database';
import { JobsService } from '../jobs/jobs.service';
import { FilesService, MAX_GENERATED_FILE_BYTES } from '../files/files.service';
import { FilesDownloadService } from '../files/files-download.service';
import { AI_CONNECTION_ENVIRONMENT } from '../ai-connections/ai-connections.module';
import { AICatalogService } from './ai-catalog.service';
import { createAITaskHoldPort } from './ai-credits';

export const AI_TASKS_OPTIONS = Symbol('AI_TASKS_OPTIONS');
/** Default byte cap of one AI output (video/audio): 200 MiB. Images keep at most IMAGE_OUTPUT_MAX_BYTES. */
export const DEFAULT_AI_OUTPUT_MAX_BYTES = 200 * 1024 * 1024;
export const IMAGE_OUTPUT_MAX_BYTES = 20 * 1024 * 1024;
export interface AITasksOptions {
  polling?: AITaskPollingOptions;
  /** Failure budget per task (1..10), default 3. */
  maxAttempts?: number;
  /**
   * Byte cap of one stored AI output (`AI_OUTPUT_MAX_BYTES`, default 200 MiB, at most 1 GiB). Separate from
   * the HTTP upload limit `FILES_MAX_BYTES`; images use min(this, 20 MiB).
   */
  outputMaxBytes?: number;
}
/** `AI_OUTPUT_MAX_BYTES`: a positive integer byte count up to MAX_GENERATED_FILE_BYTES (1 GiB). */
export function aiOutputMaxBytesFromEnvironment(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env.AI_OUTPUT_MAX_BYTES?.trim();
  if (raw === undefined || raw === '') return DEFAULT_AI_OUTPUT_MAX_BYTES;
  const value = /^\d{1,10}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_GENERATED_FILE_BYTES)
    throw new Error(`AI_OUTPUT_MAX_BYTES must be a positive integer no greater than ${MAX_GENERATED_FILE_BYTES}`);
  return value;
}
export function aiTasksOptionsFromEnvironment(env: Readonly<Record<string, string | undefined>>): AITasksOptions {
  const minutes = (name: string, fallback: number) => {
    const raw = env[name];
    const value = raw === undefined || raw === '' ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > 24 * 60) throw new Error(`${name} must be 1..1440 minutes`);
    return value * 60_000;
  };
  return { polling: { maxWaitMs: { image: minutes('AI_TASKS_IMAGE_MAX_WAIT_MINUTES', 10), video: minutes('AI_TASKS_VIDEO_MAX_WAIT_MINUTES', 30),
    audio: minutes('AI_TASKS_AUDIO_MAX_WAIT_MINUTES', 20) } }, outputMaxBytes: aiOutputMaxBytesFromEnvironment(env) };
}

const STATUSES: readonly TaskStatus[] = ['QUEUED', 'PROCESSING', 'WAITING_PROVIDER', 'RETRYING', 'COMPLETED', 'FAILED', 'CANCELLED'];
const FILE_ID = /^[a-f0-9-]{36}$/i;
const REFERENCE_MIME = new Set(['image/png', 'image/jpeg']);
const MAX_REFERENCE_BYTES = 4 * 1024 * 1024;

type OptionRule = (value: unknown) => boolean;
const int = (min: number, max: number): OptionRule => value => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const num = (min: number, max: number): OptionRule => value => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const text = (max: number, pattern?: RegExp): OptionRule => value => typeof value === 'string' && value.trim().length > 0 && value.length <= max && (!pattern || pattern.test(value));
const oneOf = (...values: string[]): OptionRule => value => typeof value === 'string' && values.includes(value);
const bool: OptionRule = value => typeof value === 'boolean';
const tags: OptionRule = value => Array.isArray(value) && value.length <= 16 && value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 64);
const shared = { negativePrompt: text(2000), seed: int(0, 2_147_483_647) };
/** Generation options a caller may send, per kind. Credentials, endpoints and the model are never options. */
const OPTION_RULES: Readonly<Record<AITaskKind, Readonly<Record<string, OptionRule>>>> = {
  image: { ...shared, width: int(64, 4096), height: int(64, 4096), count: int(1, 4), quality: oneOf('standard', 'hd'),
    style: oneOf('natural', 'vivid'), format: oneOf('png', 'jpeg', 'webp'), steps: int(1, 150), cfgScale: num(0, 50), imageStrength: num(0, 1) },
  video: { ...shared, width: int(64, 4096), height: int(64, 4096), duration: int(1, 600), fps: int(1, 60),
    resolution: text(16, /^(?:\d{3,4}p|\d{2,4}x\d{2,4})$/), cameraMotion: text(64) },
  audio: { duration: int(1, 600), lyrics: text(3000), instrumental: bool, voice: text(64), audioTags: tags },
};

export interface SubmitBody { kind: AITaskKind; providerId: string; model: string; prompt: string; options?: Record<string, AITaskOptionValue>; references?: string[]; cost?: number }

/** HTTP error mapping of submission failures (no provider detail is ever echoed). */
export function aiTaskHttpError(error: unknown): never {
  if (error instanceof HttpException) throw error;
  if (error instanceof AITaskInsufficientCreditsError)
    throw new HttpException({ code: error.code, message: 'Insufficient credits', reason: error.code, details: { required: error.required, available: error.available ?? null } }, 402);
  if (error instanceof AITaskCostChangedError)
    throw new HttpException({ code: error.code, message: 'The price changed; quote again', reason: error.code, details: { expected: error.expected, actual: error.actual } }, 409);
  if (error instanceof AITaskIdempotencyConflictError) throw new HttpException({ code: error.code, message: 'Idempotency-Key was reused with a different request' }, 409);
  if (error instanceof AITaskValidationError) throw new BadRequestException({ code: error.code, message: `Invalid ${error.field}`, reason: error.code, details: { field: error.field } });
  if (error instanceof AITaskError) throw new BadRequestException({ code: error.code, message: error.message });
  throw new ServiceUnavailableException({ code: 'AI_TASKS_UNAVAILABLE', message: 'AI tasks are temporarily unavailable' });
}

/**
 * Application host of `@zucker-framework/ai-tasks`: ports onto the canonical ledger, the owner's private
 * files (outputs become ready file assets, downloaded through the ticketed file service), the configured
 * media providers and the `ai-catalog` / `ai-pricing` policies. Registers the durable handler and the
 * hold reconciler with the one Jobs host.
 */
@Injectable()
export class AITasksService implements OnModuleInit {
  private readonly logger = new Logger(AITasksService.name);
  readonly tasks: AITaskService<ApplicationTransaction>;

  constructor(@Inject(DATABASE_ADAPTER) private readonly database: ApplicationDatabase, private readonly jobs: JobsService,
    private readonly catalog: AICatalogService, private readonly files: FilesService, private readonly downloads: FilesDownloadService,
    @Inject(AI_TASKS_OPTIONS) options: AITasksOptions,
    @Inject(AI_CONNECTION_ENVIRONMENT) private readonly env: Readonly<Record<string, string | undefined>>) {
    // Outputs are streamed into the owner's private files under their own cap (not the 10 MiB HTTP upload cap).
    const maxBytes = options.outputMaxBytes ?? DEFAULT_AI_OUTPUT_MAX_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_GENERATED_FILE_BYTES) throw new Error('Invalid AI output size limit');
    this.tasks = new AITaskService<ApplicationTransaction>({
      transactions: { runInTransaction: work => database.transaction(work) },
      holds: createAITaskHoldPort(database),
      costs: { resolve: async query => (await catalog.unitPrice(query.kind, query.model)) * this.count(query.input.options) },
      outputs: this.outputStore(),
      providers: { resolve: request => this.resolveProvider(request) },
      callbacks: { resolve: providerId => catalog.mediaProviderById(providerId)?.verifier },
      wake: id => jobs.wake(id),
      polling: options.polling,
      maxAttempts: options.maxAttempts,
      outputLimits: { maxBytes: { image: Math.min(maxBytes, IMAGE_OUTPUT_MAX_BYTES), video: maxBytes, audio: maxBytes } },
      logger: { warn: (message, context) => this.logger.warn(`${message} ${JSON.stringify(context)}`),
        error: (message, context) => this.logger.error(`${message} ${JSON.stringify(context)}`) },
    });
  }

  onModuleInit(): void {
    const registration = this.tasks.registration();
    this.jobs.registerHandler({ ...registration, handler: registration.handler as Parameters<JobsService['registerHandler']>[0]['handler'] });
    this.jobs.registerWakeSource({ name: 'ai-tasks-holds', runOnce: () => this.tasks.reconcileHolds().then(() => undefined) });
  }

  private count(options: Readonly<Record<string, AITaskOptionValue>> | undefined): number {
    const count = options?.count;
    return typeof count === 'number' && Number.isSafeInteger(count) && count > 0 ? count : 1;
  }

  /** Strict body parsing: exact keys, kind-specific options, catalog-listed provider/model, configured provider. */
  async parseSubmit(body: unknown): Promise<SubmitBody> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException({ code: 'AI_TASK_INVALID', message: 'Invalid AI task request' });
    const input = body as Record<string, unknown>;
    const unknown = Object.keys(input).find(key => !['kind', 'providerId', 'model', 'prompt', 'options', 'references', 'cost'].includes(key));
    if (unknown) throw new BadRequestException({ code: 'AI_TASK_INVALID', message: 'Unsupported AI task field', reason: 'AI_TASK_INVALID', details: { field: unknown.slice(0, 64) } });
    if (!isAITaskKind(input.kind)) throw new BadRequestException({ code: 'AI_TASK_INVALID', message: 'Invalid kind', reason: 'AI_TASK_INVALID', details: { field: 'kind' } });
    const kind = input.kind;
    if (typeof input.providerId !== 'string' || typeof input.model !== 'string' || typeof input.prompt !== 'string')
      throw new BadRequestException({ code: 'AI_TASK_INVALID', message: 'providerId, model and prompt are required' });
    if (!(await this.catalog.offered(kind, input.providerId, input.model)))
      throw new BadRequestException({ code: 'AI_MODEL_NOT_OFFERED', message: 'This model is not offered' });
    if (!this.catalog.mediaProvider(input.providerId, kind))
      throw new ServiceUnavailableException({ code: 'AI_PROVIDER_UNAVAILABLE', message: 'This model is not available right now' });
    let options: Record<string, AITaskOptionValue> | undefined;
    if (input.options !== undefined) {
      if (!input.options || typeof input.options !== 'object' || Array.isArray(input.options))
        throw new BadRequestException({ code: 'AI_TASK_INVALID', message: 'Invalid options', reason: 'AI_TASK_INVALID', details: { field: 'options' } });
      options = {};
      for (const [key, value] of Object.entries(input.options as Record<string, unknown>)) {
        const rule = Object.hasOwn(OPTION_RULES[kind], key) ? OPTION_RULES[kind][key] : undefined;
        if (!rule || !rule(value)) throw new BadRequestException({ code: 'AI_TASK_INVALID', message: 'Invalid option', reason: 'AI_TASK_INVALID', details: { field: `options.${key.slice(0, 64)}` } });
        options[key] = value as AITaskOptionValue;
      }
    }
    let references: string[] | undefined;
    if (input.references !== undefined) {
      if (kind === 'audio' || !Array.isArray(input.references) || input.references.length > 4
        || input.references.some(id => typeof id !== 'string' || !FILE_ID.test(id)))
        throw new BadRequestException({ code: 'AI_TASK_INVALID', message: 'references are up to 4 of your image file ids', reason: 'AI_TASK_INVALID', details: { field: 'references' } });
      references = [...new Set(input.references as string[])];
    }
    if (input.cost !== undefined && (!Number.isSafeInteger(input.cost) || (input.cost as number) < 0))
      throw new BadRequestException({ code: 'AI_TASK_INVALID', message: 'Invalid cost', reason: 'AI_TASK_INVALID', details: { field: 'cost' } });
    return { kind, providerId: input.providerId, model: input.model, prompt: input.prompt, options, references, ...(input.cost === undefined ? {} : { cost: input.cost as number }) };
  }

  /** Reference ids must be the caller's own ready PNG/JPEG file assets (ids, never URLs). */
  private async assertReferences(ownerId: string, references: readonly string[] | undefined): Promise<void> {
    for (const id of references ?? []) {
      const asset = await this.files.inspect(ownerId, id).catch(() => null);
      if (!asset || asset.state !== 'ready' || !REFERENCE_MIME.has(asset.mimeType) || asset.size > MAX_REFERENCE_BYTES)
        throw new BadRequestException({ code: 'AI_TASK_REFERENCE_INVALID', message: 'A reference must be one of your ready PNG/JPEG files up to 4 MiB', reason: 'AI_TASK_REFERENCE_INVALID', details: { field: 'references' } });
    }
  }

  async submit(ownerId: string, idempotencyKey: string | undefined, body: unknown): Promise<AITaskView> {
    if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_.:-]{8,128}$/.test(idempotencyKey))
      throw new BadRequestException({ code: 'AI_TASK_INVALID', message: 'A stable Idempotency-Key (8-128 characters) is required', reason: 'AI_TASK_INVALID', details: { field: 'idempotencyKey' } });
    try {
      const parsed = await this.parseSubmit(body);
      await this.assertReferences(ownerId, parsed.references);
      const { task } = await this.tasks.submitAndWake({ ownerId, kind: parsed.kind, providerId: parsed.providerId, model: parsed.model,
        input: { prompt: parsed.prompt, ...(parsed.options ? { options: parsed.options } : {}), ...(parsed.references ? { references: parsed.references } : {}) },
        idempotencyKey, ...(parsed.cost === undefined ? {} : { cost: parsed.cost }) });
      return task;
    } catch (error) {
      return aiTaskHttpError(error);
    }
  }

  async get(ownerId: string, id: string): Promise<AITaskView> {
    const task = typeof id === 'string' && id.length <= 80 ? await this.tasks.get(ownerId, id) : null;
    if (!task) throw new NotFoundException();
    return task;
  }

  async list(ownerId: string, query: Record<string, unknown>) {
    if (Object.keys(query).some(key => !['limit', 'before', 'kind', 'status'].includes(key))) throw new BadRequestException('Unsupported AI task query');
    const limit = query.limit === undefined ? 20 : Number(query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException('Invalid limit');
    if (query.kind !== undefined && !isAITaskKind(query.kind)) throw new BadRequestException('Invalid kind');
    if (query.status !== undefined && !STATUSES.includes(query.status as TaskStatus)) throw new BadRequestException('Invalid status');
    let before: { createdAt: Date; id: string } | undefined;
    if (query.before !== undefined) {
      try {
        const decoded = JSON.parse(Buffer.from(String(query.before), 'base64url').toString('utf8')) as { t?: unknown; i?: unknown };
        const createdAt = new Date(String(decoded.t));
        if (typeof decoded.i !== 'string' || decoded.i.length > 80 || !Number.isFinite(createdAt.getTime())) throw new Error();
        before = { createdAt, id: decoded.i };
      } catch { throw new BadRequestException('Invalid cursor'); }
    }
    const page = await this.tasks.list(ownerId, { limit, before, kind: query.kind as AITaskKind | undefined, status: query.status as TaskStatus | undefined });
    return { items: page.items, next: page.next ? Buffer.from(JSON.stringify({ t: page.next.createdAt.toISOString(), i: page.next.id })).toString('base64url') : null };
  }

  async cancel(ownerId: string, id: string): Promise<AITaskView> {
    const view = typeof id === 'string' && id.length <= 80 ? await this.tasks.cancelOwned(ownerId, id) : null;
    if (!view) throw new NotFoundException();
    return view;
  }

  /** A short-lived ticket for one output through the existing private file download route. */
  async outputTicket(ownerId: string, sessionId: string, id: string, index: string) {
    const position = Number(index);
    if (!/^\d{1,2}$/.test(index) || !Number.isSafeInteger(position)) throw new NotFoundException();
    const output = typeof id === 'string' && id.length <= 80 ? await this.tasks.findOutput(ownerId, id, position) : null;
    if (!output) throw new NotFoundException();
    const ticket = await this.downloads.create(ownerId, sessionId, output.storageKey);
    return { ...ticket, contentType: output.contentType, bytes: output.bytes };
  }

  /**
   * Outputs are streamed into the owner's private files with deterministic request keys (idempotent per
   * task/index) and count toward the owner's file quota; a full quota is a permanent refusal (the task
   * fails and its hold is released). `put` (buffered) remains for callers without streaming.
   */
  private outputStore(): OutputStorePort {
    const naming = (output: { taskId: string; kind: AITaskKind; index: number; contentType: string }) => {
      const hash = output.taskId.slice(4);
      const extension = AI_OUTPUT_EXTENSIONS[output.contentType] ?? 'bin';
      return { key: `ait-${hash}-${output.index}`, fileName: `ai-${output.kind}-${hash.slice(0, 12)}-${output.index + 1}.${extension}` };
    };
    const refusal = (error: unknown): never => {
      const code = error instanceof HttpException ? (error.getResponse() as { code?: unknown })?.code : undefined;
      if (code === 'FILE_QUOTA_EXCEEDED') throw new AITaskOutputRejectedError('quota');
      if (code === 'FILE_TOO_LARGE') throw new AITaskOutputRejectedError('too-large');
      throw error;
    };
    return {
      put: async output => {
        const { key, fileName } = naming(output);
        const asset = await this.files.storeGenerated(output.ownerId, key, { fileName, stream: Readable.from([output.body]), maxBytes: output.body.length })
          .catch(refusal);
        return { storageKey: asset.id };
      },
      putStream: async output => {
        const { key, fileName } = naming(output);
        const asset = await this.files.storeGenerated(output.ownerId, key, { fileName, stream: output.stream, maxBytes: output.maxBytes })
          .catch(refusal);
        return { storageKey: asset.id, bytes: asset.size, sha256: asset.sha256 };
      },
    };
  }

  private async resolveProvider(request: { ownerId: string; kind: AITaskKind; providerId: string; input: { references?: readonly string[] } }) {
    const entry = this.catalog.mediaProvider(request.providerId, request.kind);
    if (!entry) throw new Error('AI media provider is not configured');
    const config: { apiKey: string } & Record<string, unknown> = { ...entry.config };
    const [reference] = request.input.references ?? [];
    if (reference) {
      // Providers receive the owner's verified bytes inline; private storage URLs are never exposed.
      const file = await this.files.read(request.ownerId, reference);
      if (!REFERENCE_MIME.has(file.asset.mimeType) || file.body.length > MAX_REFERENCE_BYTES) throw new Error('Reference image is no longer usable');
      config[request.kind === 'video' ? 'firstFrameUrl' : 'referenceImageUrl'] = `data:${file.asset.mimeType};base64,${file.body.toString('base64')}`;
    }
    const web = this.env.WEB_URL?.trim();
    if (entry.verifier && web?.startsWith('https://'))
      config.callbackUrl = `${web.replace(/\/+$/, '')}/api/ai/tasks/callbacks/${encodeURIComponent(entry.providerId)}`;
    return { provider: entry.provider, config };
  }
}
