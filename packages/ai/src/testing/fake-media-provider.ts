import { abortableDelay, abortError } from '../abort-signal';
import {
  MediaTaskStatus,
  MediaType,
  type AudioGenerationProvider,
  type MediaGenerationConfig,
  type MediaGenerationResult,
  type MediaModelInfo,
  type MediaTaskResult,
} from '../media.interface';
import { ProviderHttpError } from '../provider-http-error';

/** 1x1 transparent PNG; the default deterministic image output. */
export const FAKE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** One scripted generation. Every field is optional; omitted fields use the provider defaults. */
export interface FakeMediaStep {
  /** Default `success`. */
  outcome?: 'success' | 'failure';
  /**
   * `async` (default): `generate` returns a PROCESSING task and `getTaskStatus` reaches the
   * terminal state. `sync`: `generate` returns the result (or throws on failure) directly.
   */
  mode?: 'sync' | 'async';
  /** Async: polls answering PROCESSING before the terminal poll. Default 0 (first poll is terminal). */
  pollsUntilDone?: number;
  /** Delay before `generate` and each `getTaskStatus` answers; honours the config's `signal`. */
  delayMs?: number;
  /** Number of outputs on success. Default 1. */
  outputs?: number;
  /** `base64` (default, no network needed) or `url` (`https://fake-media.invalid/...`, never resolvable). */
  outputKind?: 'base64' | 'url';
  /** Cost reported per task (USD). Default 0.01. */
  cost?: number;
  /** Failure message. Default `fake provider failure`. */
  error?: string;
  /**
   * Failure as a thrown `ProviderHttpError` with this HTTP status instead of a reported FAILED
   * state (sync: from `generate`; async: from the terminal poll). Sync failures always throw;
   * the default status is 422.
   */
  throwStatus?: number;
  /** Throw this status from `generate` itself (submit rejected), whatever the outcome. */
  submitStatus?: number;
}

/** A recorded call; the API key and signal are never recorded. */
export interface FakeMediaCall {
  method: 'generate' | 'getTaskStatus';
  prompt?: string;
  taskId?: string;
  config: Omit<MediaGenerationConfig, 'apiKey' | 'signal'>;
}

export interface FakeMediaProviderOptions {
  /** Default `fake-media`. */
  id?: string;
  name?: string;
  /** Default image, video and audio. */
  supportedTypes?: MediaType[];
  models?: MediaModelInfo[];
  /** Steps consumed in order by `generate`; afterwards `defaultStep` applies. */
  script?: FakeMediaStep[];
  defaultStep?: FakeMediaStep;
}

interface FakeTask {
  step: FakeMediaStep;
  polls: number;
  model: string;
  type: MediaType;
}

const EXTENSION: Record<MediaType, string> = { IMAGE: 'png', VIDEO: 'mp4', AUDIO: 'mp3' };

/**
 * Deterministic, scriptable media provider for consumers' tests (no network, no randomness).
 * Task ids are `${id}-task-${n}` in call order; outputs depend only on the task id and index.
 */
export class FakeMediaProvider implements AudioGenerationProvider {
  readonly id: string;
  readonly name: string;
  readonly supportedTypes: MediaType[];
  readonly calls: FakeMediaCall[] = [];
  private readonly models: MediaModelInfo[];
  private readonly queue: FakeMediaStep[];
  private readonly defaultStep: FakeMediaStep;
  private readonly tasks = new Map<string, FakeTask>();
  private sequence = 0;

  constructor(options: FakeMediaProviderOptions = {}) {
    this.id = options.id ?? 'fake-media';
    this.name = options.name ?? 'Fake media';
    this.supportedTypes = options.supportedTypes ?? [MediaType.IMAGE, MediaType.VIDEO, MediaType.AUDIO];
    this.models = options.models ?? this.supportedTypes.map((mediaType) => ({
      id: `fake-${mediaType.toLowerCase()}`, name: `Fake ${mediaType.toLowerCase()}`, mediaType,
    }));
    this.queue = [...(options.script ?? [])];
    this.defaultStep = options.defaultStep ?? {};
  }

  /** Append steps to the script. */
  enqueue(...steps: FakeMediaStep[]): this {
    this.queue.push(...steps);
    return this;
  }

  /** Steps not consumed yet. */
  get pendingSteps(): number {
    return this.queue.length;
  }

  /** Drop unconsumed script steps and recorded calls (the default step stays) so one instance can be reused between tests. */
  reset(): this {
    this.queue.length = 0;
    this.calls.length = 0;
    return this;
  }

  async generate(prompt: string, config: MediaGenerationConfig): Promise<MediaGenerationResult | MediaTaskResult> {
    this.calls.push({ method: 'generate', prompt, config: redact(config) });
    const step = { ...this.defaultStep, ...(this.queue.shift() ?? {}) };
    const taskId = `${this.id}-task-${++this.sequence}`;
    await this.wait(step, config);
    if (step.submitStatus !== undefined) throw new ProviderHttpError(this.name, step.submitStatus, step.error ?? 'fake submit rejected');
    const type = this.typeOf(config.modelId);
    const model = config.modelId || this.models[0]?.id || 'fake';
    if ((step.mode ?? 'async') === 'sync') {
      if ((step.outcome ?? 'success') === 'failure') {
        throw new ProviderHttpError(this.name, step.throwStatus ?? 422, step.error ?? 'fake provider failure');
      }
      return this.outputs(taskId, step, type, model)[0];
    }
    this.tasks.set(taskId, { step, polls: 0, model, type });
    return { taskId, status: MediaTaskStatus.PENDING, progress: 0, provider: this.id };
  }

  async getTaskStatus(taskId: string, config: MediaGenerationConfig): Promise<MediaTaskResult> {
    this.calls.push({ method: 'getTaskStatus', taskId, config: redact(config) });
    const task = this.tasks.get(taskId);
    if (!task) throw new ProviderHttpError(this.name, 404, `unknown task ${taskId}`);
    await this.wait(task.step, config);
    const pollsUntilDone = task.step.pollsUntilDone ?? 0;
    if (task.polls < pollsUntilDone) {
      task.polls += 1;
      return {
        taskId, status: MediaTaskStatus.PROCESSING, provider: this.id,
        progress: Math.floor((task.polls / (pollsUntilDone + 1)) * 100),
      };
    }
    if ((task.step.outcome ?? 'success') === 'failure') {
      if (task.step.throwStatus !== undefined) {
        throw new ProviderHttpError(this.name, task.step.throwStatus, task.step.error ?? 'fake provider failure');
      }
      return { taskId, status: MediaTaskStatus.FAILED, provider: this.id, error: task.step.error ?? 'fake provider failure' };
    }
    const outputs = this.outputs(taskId, task.step, task.type, task.model);
    return { taskId, status: MediaTaskStatus.COMPLETED, progress: 100, provider: this.id, result: outputs[0], outputs };
  }

  getModels(): MediaModelInfo[] {
    return this.models.map((model) => ({ ...model }));
  }

  private typeOf(modelId: string): MediaType {
    return this.models.find((model) => model.id === modelId)?.mediaType ?? this.supportedTypes[0] ?? MediaType.IMAGE;
  }

  private outputs(taskId: string, step: FakeMediaStep, type: MediaType, model: string): MediaGenerationResult[] {
    const count = Math.max(1, step.outputs ?? 1);
    const cost = step.cost ?? 0.01;
    const format = EXTENSION[type];
    return Array.from({ length: count }, (_, index) => ({
      ...((step.outputKind ?? 'base64') === 'url'
        ? { url: `https://fake-media.invalid/${encodeURIComponent(taskId)}/${index}.${format}` }
        : { base64: type === MediaType.IMAGE ? FAKE_PNG_BASE64 : Buffer.from(`${taskId}:${index}`).toString('base64') }),
      mediaType: type,
      format,
      ...(type === MediaType.IMAGE ? { width: 1, height: 1 } : { duration: 1 }),
      // Whole cost on the first output so summing outputs equals the task cost.
      cost: index === 0 ? cost : 0,
      provider: this.id,
      model,
      durationMs: 0,
    }));
  }

  private async wait(step: FakeMediaStep, config: MediaGenerationConfig): Promise<void> {
    // No timer without a delay (works under fake timers); an aborted signal still stops the call.
    if (config.signal?.aborted) throw abortError(config.signal);
    if (step.delayMs && step.delayMs > 0) await abortableDelay(step.delayMs, config.signal);
  }
}

function redact(config: MediaGenerationConfig): Omit<MediaGenerationConfig, 'apiKey' | 'signal'> {
  const { apiKey: _apiKey, signal: _signal, ...rest } = config;
  return rest;
}
