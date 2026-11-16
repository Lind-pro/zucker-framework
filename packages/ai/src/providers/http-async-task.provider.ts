import { createHmac, timingSafeEqual } from 'node:crypto';
import { assertAllowedOutboundUrl, createPublicFetch } from '@zucker-framework/core';
import { providerRequestSignal } from '../abort-signal';
import type {
  AIProviderCallbackHeaders,
  AIProviderCallbackVerification,
  AIProviderCallbackVerifier,
} from '../ai-provider-callback';
import {
  MediaTaskStatus,
  getMediaGenerationCapabilities,
  type MediaGenerationCapabilities,
  type MediaGenerationConfig,
  type MediaGenerationResult,
  type MediaModelInfo,
  type MediaProvider,
  type MediaTaskResult,
  type MediaType,
} from '../media.interface';
import { ProviderHttpError } from '../provider-http-error';
import type {
  HttpAsyncTaskAdapterConfig,
  HttpAsyncTaskCallbackVerifierOptions,
  HttpAsyncTaskRequestParam,
  HttpAsyncTaskTransport,
} from './http-async-task.config';

/** Invalid adapter configuration (raised at construction, never with secrets in the message). */
export class HttpAsyncTaskConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HttpAsyncTaskConfigError';
  }
}

const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
// Printable ASCII, but never `.` or `..`: encodeURIComponent keeps dots, so those would be resolved as
// path segments and climb out of the poll path prefix.
const TASK_ID_PATTERN = /^(?!\.{1,2}$)[\x21-\x7e]{1,256}$/;

/**
 * Generic "submit, then poll" media provider driven entirely by {@link HttpAsyncTaskAdapterConfig}
 * (no vendor baked in). Requests stay on the configured https host and go through core's
 * `createPublicFetch` unless a test transport is injected. Output URLs are returned as reported
 * (https only); consumers re-host them through their own public-URL check.
 */
export class HttpAsyncTaskMediaProvider implements MediaProvider {
  readonly id: string;
  readonly name: string;
  readonly supportedTypes: MediaType[];
  private readonly base: URL;
  private readonly ports: readonly number[];
  private readonly send: (url: string, init: RequestInit) => Promise<Response>;
  private readonly maxBytes: number;

  constructor(
    private readonly config: HttpAsyncTaskAdapterConfig,
    transport: HttpAsyncTaskTransport = {},
  ) {
    if (!config || typeof config !== 'object') throw new HttpAsyncTaskConfigError('Adapter configuration is required');
    if (typeof config.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(config.id)) {
      throw new HttpAsyncTaskConfigError('Adapter id must be 1-64 letters, digits, dot, dash or underscore');
    }
    if (!Array.isArray(config.models) || config.models.length === 0
      || config.models.some((model) => !model?.id || model.mediaType !== config.mediaType)) {
      throw new HttpAsyncTaskConfigError(`Adapter ${config.id} needs models of type ${String(config.mediaType)}`);
    }
    this.ports = config.allowedPorts ?? [443];
    this.base = this.checkUrl(config.baseUrl, undefined, 'baseUrl');
    this.base.search = '';
    this.base.hash = '';
    checkPath(config.submit?.path, 'submit.path');
    checkPath(config.poll?.path, 'poll.path');
    if (!config.poll.path.includes('{taskId}')) throw new HttpAsyncTaskConfigError('poll.path must contain {taskId}');
    for (const [label, path] of [
      ['submit.taskIdPath', config.submit.taskIdPath], ['poll.statusPath', config.poll.statusPath],
      ['poll.outputPath', config.poll.outputPath], ['poll.outputItemUrlField', config.poll.outputItemUrlField],
      ['poll.progressPath', config.poll.progressPath], ['poll.errorPath', config.poll.errorPath],
      ...Object.entries(config.submit.fields ?? {}).map(([param, field]) => [`submit.fields.${param}`, field]),
    ] as const) {
      if (path !== undefined || label === 'submit.taskIdPath' || label === 'poll.statusPath' || label === 'poll.outputPath') {
        checkFieldPath(path, label);
      }
    }
    if (!config.poll.status || !config.poll.status.completed?.length || !config.poll.status.failed?.length) {
      throw new HttpAsyncTaskConfigError('poll.status needs completed and failed values');
    }
    if (config.auth?.type === 'header' && !/^[a-z0-9-]{1,64}$/i.test(config.auth.name)) {
      throw new HttpAsyncTaskConfigError('auth.name must be a header name');
    }
    // Validates header names/values early (Headers throws on invalid ones).
    new Headers(config.headers ?? {});
    this.maxBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) throw new HttpAsyncTaskConfigError('maxResponseBytes must be a positive integer');
    this.id = config.id;
    this.name = config.name ?? config.id;
    this.supportedTypes = [config.mediaType];
    getMediaGenerationCapabilities(this, config.models[0].id);
    if ((config.maxOutputs ?? 1) > 1 && !config.submit.fields?.count) throw new HttpAsyncTaskConfigError('Multiple outputs require submit.fields.count');
    if ((config.maxReferences ?? 0) > 0 && !this.getCapabilities().referenceInput)
      throw new HttpAsyncTaskConfigError('References require a mapped reference field');
    if (this.getCapabilities().referenceInput === 'frames' && this.getCapabilities().maxReferences > 1 && !config.submit.fields?.lastFrameUrl)
      throw new HttpAsyncTaskConfigError('Two reference frames require submit.fields.lastFrameUrl');
    this.send = transport.fetch
      ?? createPublicFetch({ allowedProtocols: ['https:'], allowedPorts: this.ports, resolve: transport.resolve });
  }

  getModels(): MediaModelInfo[] {
    return this.config.models.map((model) => ({ ...model }));
  }

  getCapabilities(): MediaGenerationCapabilities {
    const fields = this.config.submit.fields;
    const referenceInput = fields?.referenceImageUrls ? 'multiple' : fields?.referenceImageUrl ? 'single' : fields?.firstFrameUrl ? 'frames' : undefined;
    const inferred = referenceInput === 'single' ? 1 : referenceInput === 'frames' ? (fields?.lastFrameUrl ? 2 : 1) : 0;
    return { maxOutputs: this.config.maxOutputs ?? 1, maxReferences: this.config.maxReferences ?? inferred, ...(referenceInput ? { referenceInput } : {}) };
  }

  async generate(prompt: string, config: MediaGenerationConfig): Promise<MediaTaskResult> {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new TypeError('Prompt must be non-empty text');
    const modelId = config.modelId || this.config.models[0].id;
    const capabilities = getMediaGenerationCapabilities(this, modelId);
    if (!Number.isSafeInteger(config.count ?? 1) || (config.count ?? 1) < 1 || (config.count ?? 1) > capabilities.maxOutputs)
      throw new RangeError('Requested output count exceeds adapter capabilities');
    const references = config.referenceImageUrls?.length ?? (config.referenceImageUrl ? 1 : (config.firstFrameUrl ? 1 : 0) + (config.lastFrameUrl ? 1 : 0));
    if (references > capabilities.maxReferences) throw new RangeError('Requested references exceed adapter capabilities');
    if (!this.config.models.some((model) => model.id === modelId)) throw new TypeError(`Unknown model for ${this.id}: ${modelId}`);
    this.assertSameEndpoint(config);
    const body = this.submitBody(prompt, { ...config, modelId });
    const data = await this.request(this.config.submit.method ?? 'POST', this.config.submit.path, config, body);
    const taskId = readPath(data, this.config.submit.taskIdPath);
    const id = typeof taskId === 'number' && Number.isSafeInteger(taskId) ? String(taskId) : taskId;
    if (typeof id !== 'string' || !TASK_ID_PATTERN.test(id)) {
      throw new ProviderHttpError(this.name, 502, 'Submit response has no valid task id');
    }
    // Some APIs answer the submit with the task's state; parse it when the status is present.
    if (readPath(data, this.config.poll.statusPath) !== undefined) return this.parseTask(id, data, modelId);
    return { taskId: id, status: MediaTaskStatus.PENDING, provider: this.id };
  }

  async getTaskStatus(taskId: string, config: MediaGenerationConfig): Promise<MediaTaskResult> {
    if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId)) throw new TypeError('Invalid provider task id');
    this.assertSameEndpoint(config);
    const path = this.config.poll.path.replaceAll('{taskId}', encodeURIComponent(taskId));
    const data = await this.request(this.config.poll.method ?? 'GET', path, config);
    return this.parseTask(taskId, data, config.modelId || this.config.models[0].id);
  }

  /**
   * HMAC verifier for this provider's callbacks. The signature covers the exact raw body
   * (`${timestamp}.${body}` when `timestampHeader` is set). Returns `null` for anything it cannot
   * authenticate; see {@link AIProviderCallbackVerifier} for what consumers may do with each result.
   */
  createCallbackVerifier(options: HttpAsyncTaskCallbackVerifierOptions): AIProviderCallbackVerifier {
    if (typeof options?.secret !== 'string' || Buffer.byteLength(options.secret) < 16) {
      throw new HttpAsyncTaskConfigError('Callback secret must be at least 16 bytes');
    }
    if (!/^[a-z0-9-]{1,64}$/i.test(options.signatureHeader ?? '')) throw new HttpAsyncTaskConfigError('signatureHeader must be a header name');
    if (options.timestampHeader !== undefined && !/^[a-z0-9-]{1,64}$/i.test(options.timestampHeader)) {
      throw new HttpAsyncTaskConfigError('timestampHeader must be a header name');
    }
    const taskIdPath = options.taskIdPath ?? this.config.submit.taskIdPath;
    checkFieldPath(taskIdPath, 'taskIdPath');
    const algorithm = options.algorithm ?? 'sha256';
    const encoding = options.encoding ?? 'hex';
    const tolerance = options.toleranceSeconds ?? 300;
    const now = options.now ?? Date.now;
    const parse = options.parseTask ?? true;
    const provider = this;
    return {
      providerId: this.id,
      async verify(rawBody, headers): Promise<AIProviderCallbackVerification | null> {
        try {
          const bytes = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
          if (bytes.length === 0 || bytes.length > provider.maxBytes) return null;
          let signature = header(headers, options.signatureHeader);
          if (!signature) return null;
          if (options.signaturePrefix) {
            if (!signature.startsWith(options.signaturePrefix)) return null;
            signature = signature.slice(options.signaturePrefix.length);
          }
          const hmac = createHmac(algorithm, options.secret);
          if (options.timestampHeader) {
            const timestamp = header(headers, options.timestampHeader);
            if (!timestamp || !/^\d{1,12}$/.test(timestamp)) return null;
            if (Math.abs(now() / 1000 - Number(timestamp)) > tolerance) return null;
            hmac.update(`${timestamp}.`);
          }
          const expected = hmac.update(bytes).digest();
          const received = decodeSignature(signature, encoding);
          if (!received || received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
          const payload: unknown = JSON.parse(bytes.toString('utf8'));
          const rawId = readPath(payload, taskIdPath);
          const providerTaskId = typeof rawId === 'number' && Number.isSafeInteger(rawId) ? String(rawId) : rawId;
          if (typeof providerTaskId !== 'string' || !TASK_ID_PATTERN.test(providerTaskId)) return null;
          if (!parse || readPath(payload, provider.config.poll.statusPath) === undefined) return { providerTaskId };
          return { providerTaskId, task: provider.parseTask(providerTaskId, payload, provider.config.models[0].id) };
        } catch {
          return null;
        }
      },
      // Unauthenticated: only the task id the body claims, for one rate-limited early poll.
      hint(rawBody): string | null {
        try {
          const bytes = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
          if (bytes.length === 0 || bytes.length > provider.maxBytes) return null;
          const rawId = readPath(JSON.parse(bytes.toString('utf8')) as unknown, taskIdPath);
          const providerTaskId = typeof rawId === 'number' && Number.isSafeInteger(rawId) ? String(rawId) : rawId;
          return typeof providerTaskId === 'string' && TASK_ID_PATTERN.test(providerTaskId) ? providerTaskId : null;
        } catch {
          return null;
        }
      },
    };
  }

  private parseTask(taskId: string, data: unknown, model: string): MediaTaskResult {
    const poll = this.config.poll;
    const raw = readPath(data, poll.statusPath);
    const value = typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : undefined;
    const status = value === undefined ? undefined
      : poll.status.completed.includes(value) ? MediaTaskStatus.COMPLETED
        : poll.status.failed.includes(value) ? MediaTaskStatus.FAILED
          : poll.status.processing?.includes(value) ? MediaTaskStatus.PROCESSING
            : poll.status.pending?.includes(value) ? MediaTaskStatus.PENDING : undefined;
    const result: MediaTaskResult = { taskId, status: status ?? MediaTaskStatus.FAILED, provider: this.id };
    const progress = poll.progressPath ? readPath(data, poll.progressPath) : undefined;
    if (typeof progress === 'number' && Number.isFinite(progress)) {
      result.progress = Math.max(0, Math.min(100, Math.round((progress / (poll.progressScale ?? 100)) * 100)));
    }
    if (status === undefined) {
      // Unknown states fail instead of polling forever; the raw value is not echoed (provider-controlled).
      result.error = `${this.name} returned an unknown task status`;
      return result;
    }
    if (status === MediaTaskStatus.FAILED) {
      const message = poll.errorPath ? readPath(data, poll.errorPath) : undefined;
      result.error = typeof message === 'string' && message ? message.slice(0, 500) : `${this.name} task failed`;
      return result;
    }
    if (status !== MediaTaskStatus.COMPLETED) return result;
    const urls = this.outputUrls(readPath(data, poll.outputPath));
    if (!urls.length) {
      return { ...result, status: MediaTaskStatus.FAILED, error: `${this.name} completed without a valid https output URL` };
    }
    const outputs: MediaGenerationResult[] = urls.map((url, index) => ({
      url, mediaType: this.config.mediaType, cost: index === 0 ? this.config.costPerTask ?? 0 : 0,
      provider: this.id, model, durationMs: 0,
    }));
    return { ...result, progress: 100, result: outputs[0], outputs };
  }

  private outputUrls(value: unknown): string[] {
    const items = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
    const field = this.config.poll.outputItemUrlField;
    return items.slice(0, 16)
      .map((item) => (field && item && typeof item === 'object' ? readPath(item, field) : item))
      .filter((url): url is string => {
        if (typeof url !== 'string' || url.length > 4096) return false;
        try {
          const parsed = new URL(url);
          return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
        } catch {
          return false;
        }
      });
  }

  private submitBody(prompt: string, config: MediaGenerationConfig): Record<string, unknown> {
    const body = structuredClone({ ...(this.config.submit.body ?? {}) }) as Record<string, unknown>;
    const fields: Partial<Record<HttpAsyncTaskRequestParam, string>> = { prompt: 'prompt', model: 'model', ...this.config.submit.fields };
    const values: Record<HttpAsyncTaskRequestParam, unknown> = {
      prompt, model: config.modelId, negativePrompt: config.negativePrompt, width: config.width, height: config.height,
      format: config.format, count: config.count, seed: config.seed, steps: config.steps, cfgScale: config.cfgScale,
      quality: config.quality, style: config.style, referenceImageUrl: config.referenceImageUrl,
      referenceImageUrls: config.referenceImageUrls,
      imageStrength: config.imageStrength, duration: config.duration, fps: config.fps, resolution: config.resolution,
      firstFrameUrl: config.firstFrameUrl, lastFrameUrl: config.lastFrameUrl, cameraMotion: config.cameraMotion,
      lyrics: config.lyrics, instrumental: config.instrumental, voice: config.voice, audioTags: config.audioTags,
      callbackUrl: config.callbackUrl,
      clientRequestId: config.clientRequestId,
    };
    for (const [param, field] of Object.entries(fields) as [HttpAsyncTaskRequestParam, string | undefined][]) {
      if (field && values[param] !== undefined) writePath(body, field, values[param]);
    }
    return body;
  }

  private async request(method: string, path: string, config: MediaGenerationConfig, body?: unknown): Promise<unknown> {
    const url = this.checkUrl(`${this.base.href.replace(/\/$/, '')}${path}`, this.base.hostname, 'request URL');
    const headers = new Headers(this.config.headers ?? {});
    headers.set('accept', 'application/json');
    const auth = this.config.auth ?? { type: 'bearer' };
    if (auth.type !== 'none') {
      if (!config.apiKey) throw new HttpAsyncTaskConfigError(`${this.name} requires an API key`);
      if (auth.type === 'bearer') headers.set('authorization', `Bearer ${config.apiKey}`);
      else headers.set(auth.name, config.apiKey);
    }
    if (body !== undefined) headers.set('content-type', 'application/json');
    const response = await this.send(url.href, {
      method, headers, redirect: 'manual',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: providerRequestSignal(config.signal, config.timeoutMs),
    });
    const text = await readBounded(response, this.maxBytes, this.name);
    if (!response.ok) throw new ProviderHttpError(this.name, response.status, text.slice(0, 1_000) || response.statusText);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ProviderHttpError(this.name, 502, 'Response is not JSON');
    }
  }

  /** Endpoints come only from the adapter configuration; a per-call baseURL must not redirect requests. */
  private assertSameEndpoint(config: MediaGenerationConfig): void {
    if (config.baseURL && this.checkUrl(config.baseURL, undefined, 'baseURL').href.replace(/\/$/, '') !== this.base.href.replace(/\/$/, '')) {
      throw new HttpAsyncTaskConfigError(`${this.name} endpoints come from the adapter configuration; baseURL override refused`);
    }
  }

  /** https, no credentials, no localhost/IP literal, allowed port, and (for requests) the configured host only. */
  private checkUrl(input: unknown, host: string | undefined, label: string): URL {
    if (typeof input !== 'string') throw new HttpAsyncTaskConfigError(`${label} must be an https URL`);
    let hostname: string;
    try {
      hostname = host ?? new URL(input).hostname;
    } catch {
      throw new HttpAsyncTaskConfigError(`${label} must be an https URL`);
    }
    try {
      return assertAllowedOutboundUrl(input, { allowedHosts: [hostname], allowedProtocols: ['https:'], allowedPorts: this.ports });
    } catch (error) {
      throw new HttpAsyncTaskConfigError(`${label} refused: ${error instanceof Error ? error.message : 'invalid'}`);
    }
  }
}

function checkPath(path: unknown, label: string): asserts path is string {
  // Relative to baseUrl: one leading slash, no scheme-relative `//host`, no backslashes or dot segments.
  if (typeof path !== 'string' || !/^\/(?!\/)[^\s\\#]*$/.test(path) || /(^|\/)\.\.?(\/|$|\?)/.test(path)) {
    throw new HttpAsyncTaskConfigError(`${label} must be a path starting with a single /`);
  }
}

function checkFieldPath(path: unknown, label: string): asserts path is string {
  if (typeof path !== 'string' || !path || path.split('.').some((segment) => !segment || FORBIDDEN_SEGMENTS.has(segment))) {
    throw new HttpAsyncTaskConfigError(`${label} must be a dotted field path`);
  }
}

/** Reads a dotted path through own properties only. */
function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined;
      current = current[Number(segment)];
    } else {
      if (!Object.hasOwn(current, segment)) return undefined;
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current;
}

function writePath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const next = Object.hasOwn(current, segment) ? current[segment] : undefined;
    if (!next || typeof next !== 'object' || Array.isArray(next)) current[segment] = {};
    current = current[segment] as Record<string, unknown>;
  }
  current[segments[segments.length - 1]] = value;
}

async function readBounded(response: Response, limit: number, provider: string): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderHttpError(provider, 502, 'Response too large');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new ProviderHttpError(provider, 502, 'Response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function header(headers: AIProviderCallbackHeaders, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() !== wanted) continue;
    // A repeated signature header is ambiguous; refuse it.
    if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
    return typeof value === 'string' ? value.trim() : undefined;
  }
  return undefined;
}

function decodeSignature(value: string, encoding: 'hex' | 'base64'): Buffer | undefined {
  if (encoding === 'hex') return /^(?:[0-9a-f]{2})+$/i.test(value) ? Buffer.from(value, 'hex') : undefined;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value) ? Buffer.from(value, 'base64') : undefined;
}
