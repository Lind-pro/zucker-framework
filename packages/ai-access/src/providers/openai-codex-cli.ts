import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  credentialProfileId,
  type AIAccessProviderPlugin,
  type AIAccessRequest,
  type AIAccessResult,
} from '../contracts';
import { codexInferenceConfigArgs } from './codex-inference-config';
import { runCodexAppServer } from './openai-codex-app-server';

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const STDERR_LIMIT = 8_192;
/** One JSONL line larger than this is treated as invalid output (matches the app-server path). */
const STDOUT_LINE_LIMIT = 16 * 1024 * 1024;
const SAFE_ENVIRONMENT_KEYS = new Set([
  'ALL_PROXY',
  'CODEX_CA_CERTIFICATE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LANG',
  'LC_ALL',
  'NO_PROXY',
  'PATH',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'TEMP',
  'TMP',
  'TMPDIR',
  'TZ',
]);

export type CodexCliSubscriptionErrorCode =
  | 'NOT_CONFIGURED'
  | 'SPAWN_FAILED'
  | 'AUTH_REQUIRED'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'EXECUTION_FAILED'
  | 'INVALID_OUTPUT';

export class CodexCliSubscriptionError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: CodexCliSubscriptionErrorCode,
    message: string,
    options: { cause?: unknown; retryable?: boolean } = {},
  ) {
    super(message, options.cause instanceof Error ? { cause: options.cause } : undefined);
    this.name = 'CodexCliSubscriptionError';
    this.retryable =
      options.retryable ?? ['RATE_LIMITED', 'TIMEOUT', 'EXECUTION_FAILED'].includes(code);
  }
}

export interface CodexCliCommand {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export type CodexCliCommandRunner = (command: CodexCliCommand) => Promise<AIAccessResult>;

export type CodexUnsupportedSchemaPolicy = 'error' | 'prompt-json';

export interface CodexSchemaFallbackEvent {
  unsupportedKeywords: string[];
}

export interface OpenAICodexCliSubscriptionProviderOptions {
  executable?: string;
  codexHome: string;
  workingDirectory: string;
  environment?: Record<string, string | undefined>;
  timeoutMs?: number;
  commandRunner?: CodexCliCommandRunner;
  unsupportedSchemaPolicy?: CodexUnsupportedSchemaPolicy;
  onSchemaFallback?: (event: CodexSchemaFallbackEvent) => void;
}

export class OpenAICodexCliSubscriptionProvider {
  readonly id = 'openai-codex-cli';
  readonly name = 'OpenAI Codex Subscription CLI';
  private readonly executable: string;
  private readonly codexHome: string;
  private readonly workingDirectory: string;
  private readonly environment: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly commandRunner: CodexCliCommandRunner;
  private readonly unsupportedSchemaPolicy: CodexUnsupportedSchemaPolicy;
  private readonly onSchemaFallback?: (event: CodexSchemaFallbackEvent) => void;

  constructor(options: OpenAICodexCliSubscriptionProviderOptions) {
    this.executable = options.executable?.trim() || 'codex';
    this.codexHome = requireAbsolutePath(options.codexHome, 'codexHome');
    this.workingDirectory = requireAbsolutePath(options.workingDirectory, 'workingDirectory');
    this.environment = buildEnvironment(options.environment, this.codexHome);
    this.timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs');
    this.commandRunner = options.commandRunner ?? runCodexCliCommand;
    this.unsupportedSchemaPolicy = options.unsupportedSchemaPolicy ?? 'error';
    this.onSchemaFallback = options.onSchemaFallback;
  }

  async createModel(config: {
    modelId: string;
    timeoutMs?: number;
  }): Promise<OpenAICodexCliSubscriptionClient> {
    const modelId = config.modelId.trim();
    if (!modelId) {
      throw new CodexCliSubscriptionError('NOT_CONFIGURED', 'Codex 订阅模型 ID 不能为空。');
    }
    return new OpenAICodexCliSubscriptionClient({
      executable: this.executable,
      codexHome: this.codexHome,
      workingDirectory: this.workingDirectory,
      environment: this.environment,
      timeoutMs: positiveInteger(config.timeoutMs, this.timeoutMs, 'timeoutMs'),
      commandRunner: this.commandRunner,
      modelId,
      unsupportedSchemaPolicy: this.unsupportedSchemaPolicy,
      onSchemaFallback: this.onSchemaFallback,
    });
  }
}

export function createOpenAICodexCliAccessProvider(
  options: OpenAICodexCliSubscriptionProviderOptions,
): AIAccessProviderPlugin {
  const provider = new OpenAICodexCliSubscriptionProvider(options);
  return {
    id: provider.id,
    name: provider.name,
    authMethods: [],
    credentialSources: [
      {
        id: 'codex-home',
        label: 'Official Codex CLI home',
        kind: 'file',
        ownership: 'external-readonly',
        discover: async (context) => {
          const now = Date.now();
          return [
            {
              id: credentialProfileId(provider.id, context.profileName),
              providerId: provider.id,
              profileName: context.profileName,
              authMethod: 'codex-cli-login',
              ownership: 'external-readonly',
              credential: {
                kind: 'external-reference',
                source: 'codex-home',
                reference: options.codexHome,
              },
              metadata: { createdAt: now, updatedAt: now },
            },
          ];
        },
      },
    ],
    runtime: {
      complete: async (request) => {
        const client = await provider.createModel({ modelId: request.model });
        return client.complete(request);
      },
    },
  };
}

interface OpenAICodexCliSubscriptionClientOptions {
  executable: string;
  codexHome: string;
  workingDirectory: string;
  environment: Record<string, string>;
  timeoutMs: number;
  commandRunner: CodexCliCommandRunner;
  modelId: string;
  unsupportedSchemaPolicy: CodexUnsupportedSchemaPolicy;
  onSchemaFallback?: (event: CodexSchemaFallbackEvent) => void;
}

export class OpenAICodexCliSubscriptionClient {
  constructor(private readonly options: OpenAICodexCliSubscriptionClientOptions) {}

  async complete(
    request: Omit<AIAccessRequest, 'model'> & { model?: string },
  ): Promise<AIAccessResult> {
    const model = request.model?.trim() || this.options.modelId;
    const input = request.input.trim();
    if (!input) {
      throw new CodexCliSubscriptionError('NOT_CONFIGURED', 'Codex 订阅调用输入不能为空。');
    }

    // exec --json only emits completed messages. Use the official app-server
    // delta protocol for live text; never replay a completed answer as a stream.
    if (request.onTextDelta) {
      let outputSchema = request.outputSchema;
      let instructions = request.instructions;
      if (outputSchema !== undefined) {
        assertJsonSchema(outputSchema);
        const unsupportedKeywords = findUnsupportedSchemaKeywords(outputSchema);
        if (unsupportedKeywords.length) {
          if (this.options.unsupportedSchemaPolicy === 'error') {
            throw new CodexCliSubscriptionError(
              'NOT_CONFIGURED',
              `Codex outputSchema 包含不支持的关键字：${unsupportedKeywords.join(', ')}。`,
            );
          }
          try {
            this.options.onSchemaFallback?.({ unsupportedKeywords });
          } catch {
            // Diagnostic observers must never change provider behavior.
          }
          instructions = buildJsonPrompt(instructions, '', outputSchema);
          outputSchema = undefined;
        } else outputSchema = normalizeStrictOutputSchema(outputSchema);
      }
      return runCodexAppServer({
        executable: this.options.executable,
        cwd: this.options.workingDirectory,
        env: { ...this.options.environment, CODEX_HOME: this.options.codexHome },
        timeoutMs: this.options.timeoutMs,
        request: { ...request, model, input, instructions, outputSchema },
      });
    }

    let schemaDirectory: string | undefined;
    try {
      const args = this.buildArgs(model, request);
      let stdin = buildPrompt(request.instructions, input);
      if (request.outputSchema !== undefined) {
        assertJsonSchema(request.outputSchema);
        const unsupportedKeywords = findUnsupportedSchemaKeywords(request.outputSchema);
        if (unsupportedKeywords.length > 0) {
          if (this.options.unsupportedSchemaPolicy === 'error') {
            throw new CodexCliSubscriptionError(
              'NOT_CONFIGURED',
              `Codex outputSchema 包含不支持的关键字：${unsupportedKeywords.join(', ')}。`,
            );
          }
          try {
            this.options.onSchemaFallback?.({ unsupportedKeywords });
          } catch {
            // Diagnostic observers must never change provider behavior.
          }
          stdin = buildJsonPrompt(request.instructions, input, request.outputSchema);
        } else {
          schemaDirectory = await mkdtemp(join(tmpdir(), 'zucker-codex-schema-'));
          const schemaPath = join(schemaDirectory, 'schema.json');
          await writeFile(
            schemaPath,
            JSON.stringify(normalizeStrictOutputSchema(request.outputSchema)),
            {
              encoding: 'utf8',
              mode: 0o600,
            },
          );
          args.splice(args.length - 1, 0, '--output-schema', schemaPath);
        }
      }
      return await this.options.commandRunner({
        executable: this.options.executable,
        args,
        cwd: this.options.workingDirectory,
        env: { ...this.options.environment, CODEX_HOME: this.options.codexHome },
        stdin,
        timeoutMs: this.options.timeoutMs,
        signal: request.signal,
      });
    } finally {
      if (schemaDirectory) await rm(schemaDirectory, { recursive: true, force: true });
    }
  }

  private buildArgs(
    model: string,
    request: Omit<AIAccessRequest, 'model'> & { model?: string },
  ): string[] {
    const args = [
      'exec',
      '--json',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--strict-config',
      '--skip-git-repo-check',
      '--color',
      'never',
      ...codexInferenceConfigArgs(),
      '--model',
      model,
      '--cd',
      this.options.workingDirectory,
      '-',
    ];
    if (request.reasoningEffort && request.reasoningEffort !== 'none') {
      args.splice(
        args.length - 1,
        0,
        '--config',
        `model_reasoning_effort="${request.reasoningEffort}"`,
      );
    }
    if (request.textVerbosity) {
      args.splice(args.length - 1, 0, '--config', `model_verbosity="${request.textVerbosity}"`);
    }
    return args;
  }
}

async function runCodexCliCommand(command: CodexCliCommand): Promise<AIAccessResult> {
  if (command.signal?.aborted) {
    throw new CodexCliSubscriptionError('CANCELLED', 'Codex 订阅调用已取消。');
  }

  return new Promise<AIAccessResult>((resolve, reject) => {
    let child;
    try {
      child = spawn(command.executable, command.args, {
        cwd: command.cwd,
        env: command.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(
        new CodexCliSubscriptionError('SPAWN_FAILED', '无法启动 Codex CLI。', { cause: error }),
      );
      return;
    }

    let settled = false;
    let cancelled = false;
    let timedOut = false;
    let stderr = '';
    let stdoutBuffer = '';
    let responseId: string | undefined;
    let content = '';
    let usage: AIAccessResult['tokenUsage'];
    let reconnectError: CodexCliSubscriptionError | undefined;
    let streamError: CodexCliSubscriptionError | undefined;

    const terminate = () => {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 5_000);
      killTimer.unref?.();
    };
    const onAbort = () => {
      cancelled = true;
      terminate();
    };
    command.signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, command.timeoutMs);
    timeout.unref?.();

    const cleanup = () => {
      clearTimeout(timeout);
      command.signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: CodexCliSubscriptionError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const parseLine = (line: string) => {
      if (!line.trim() || streamError) return;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch (error) {
        streamError = new CodexCliSubscriptionError(
          'INVALID_OUTPUT',
          'Codex CLI 返回了无效 JSONL。',
          { cause: error },
        );
        terminate();
        return;
      }
      if (!isRecord(event)) return;
      const type = stringValue(event.type);
      if (type === 'thread.started') {
        responseId = stringValue(event.thread_id);
      } else if (type === 'item.completed' && isRecord(event.item)) {
        if (event.item.type === 'agent_message' && typeof event.item.text === 'string') {
          content = event.item.text;
        }
      } else if (type === 'turn.completed' && isRecord(event.usage)) {
        const inputTokens = nonNegativeNumber(event.usage.input_tokens);
        const outputTokens = nonNegativeNumber(event.usage.output_tokens);
        if (inputTokens === undefined || outputTokens === undefined || !Number.isSafeInteger(inputTokens + outputTokens)) {
          streamError = new CodexCliSubscriptionError('INVALID_OUTPUT', 'Codex CLI 完成事件的用量无效。');
        } else usage = { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens };
      } else if (type === 'turn.failed') {
        streamError = classifyEventFailure(event);
      } else if (type === 'error') {
        // The CLI emits reconnect progress as error events before the turn's
        // final outcome. Keep its diagnostic without discarding later output.
        if (/^Reconnecting\.\.\.\s+\d+\/\d+(?:\s+\(.*\))?$/.test(extractEventErrorMessage(event))) reconnectError = classifyEventFailure(event);
        else streamError = classifyEventFailure(event);
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (streamError) return;
      stdoutBuffer += chunk;
      for (;;) {
        const newline = stdoutBuffer.indexOf('\n');
        if (newline < 0) break;
        parseLine(stdoutBuffer.slice(0, newline));
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
      }
      if (stdoutBuffer.length > STDOUT_LINE_LIMIT) {
        stdoutBuffer = '';
        streamError ??= new CodexCliSubscriptionError('INVALID_OUTPUT', 'Codex CLI 输出行超过大小限制。');
        terminate();
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < STDERR_LIMIT) stderr += chunk.slice(0, STDERR_LIMIT - stderr.length);
    });
    child.once('error', (error) => {
      fail(new CodexCliSubscriptionError('SPAWN_FAILED', '无法启动 Codex CLI。', { cause: error }));
    });
    child.once('close', (code) => {
      if (settled) return;
      if (stdoutBuffer.trim()) parseLine(stdoutBuffer);
      if (cancelled) {
        fail(new CodexCliSubscriptionError('CANCELLED', 'Codex 订阅调用已取消。'));
        return;
      }
      if (timedOut) {
        fail(new CodexCliSubscriptionError('TIMEOUT', 'Codex 订阅调用超时。'));
        return;
      }
      if (streamError) {
        fail(streamError);
        return;
      }
      if (code !== 0) {
        fail(reconnectError ?? classifyProcessFailure(stderr));
        return;
      }
      if (!usage) {
        fail(reconnectError ?? new CodexCliSubscriptionError('INVALID_OUTPUT', 'Codex CLI 未返回完成事件及实际用量。'));
        return;
      }
      if (!content.trim()) {
        fail(new CodexCliSubscriptionError('INVALID_OUTPUT', 'Codex CLI 未返回最终答案。'));
        return;
      }
      settled = true;
      cleanup();
      resolve({
        content: content.trim(),
        finishReason: 'completed',
        ...(responseId ? { responseId } : {}),
        tokenUsage: usage,
      });
    });

    child.stdin.once('error', () => terminate());
    child.stdin.end(command.stdin);
  });
}

function buildEnvironment(
  input: Record<string, string | undefined> | undefined,
  codexHome: string,
): Record<string, string> {
  const environment: Record<string, string> = { CODEX_HOME: codexHome };
  for (const [key, value] of Object.entries(input ?? {})) {
    if (!SAFE_ENVIRONMENT_KEYS.has(key)) {
      throw new CodexCliSubscriptionError(
        'NOT_CONFIGURED',
        `Codex 订阅子进程环境不允许注入 ${key}。`,
      );
    }
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function buildPrompt(instructions: string | undefined, input: string): string {
  const normalizedInstructions = instructions?.trim();
  return normalizedInstructions ? `${normalizedInstructions}\n\n---\n\n${input}` : input;
}

function buildJsonPrompt(
  instructions: string | undefined,
  input: string,
  schema: Record<string, unknown>,
): string {
  const jsonInstruction =
    'Return exactly one JSON value matching the JSON Schema below. ' +
    'Do not include Markdown fences, commentary, or any text outside the JSON value.\n\n' +
    JSON.stringify(schema);
  return buildPrompt(
    [instructions?.trim(), jsonInstruction].filter(Boolean).join('\n\n'),
    input,
  );
}

function requireAbsolutePath(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized || !isAbsolute(normalized)) {
    throw new CodexCliSubscriptionError('NOT_CONFIGURED', `Codex 订阅 ${name} 必须是绝对路径。`);
  }
  return normalized;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new CodexCliSubscriptionError('NOT_CONFIGURED', `Codex 订阅 ${name} 必须是正整数。`);
  }
  return value;
}

function assertJsonSchema(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new CodexCliSubscriptionError('NOT_CONFIGURED', 'Codex outputSchema 必须是 JSON 对象。');
  }
}

function normalizeStrictOutputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return normalizeSchemaNode(schema) as Record<string, unknown>;
}

function normalizeSchemaNode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeSchemaNode);
  if (!isRecord(value)) return value;

  const normalized = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, normalizeSchemaNode(child)]),
  );
  if (isRecord(normalized.properties)) {
    normalized.required = Object.keys(normalized.properties);
    normalized.additionalProperties = false;
  }
  return normalized;
}

function findUnsupportedSchemaKeywords(schema: Record<string, unknown>): string[] {
  const found = new Set<string>();
  visitSchemaNode(schema, found);
  return [...found].sort();
}

function visitSchemaNode(node: unknown, found: Set<string>): void {
  if (!isRecord(node)) return;

  for (const keyword of [
    'allOf',
    'dependentRequired',
    'dependentSchemas',
    'else',
    'if',
    'not',
    'oneOf',
    'patternProperties',
    'propertyNames',
    'then',
    'unevaluatedProperties',
  ]) {
    if (keyword in node) found.add(keyword);
  }
  if ('additionalProperties' in node && node.additionalProperties !== false) {
    found.add('additionalProperties(schema)');
  }
  if (isRecord(node.properties)) {
    Object.values(node.properties).forEach((child) => visitSchemaNode(child, found));
  }
  for (const definitionsKey of ['$defs', 'definitions'] as const) {
    if (isRecord(node[definitionsKey])) {
      Object.values(node[definitionsKey]).forEach((child) => visitSchemaNode(child, found));
    }
  }
  visitSchemaNode(node.items, found);
  for (const unionKey of ['anyOf', 'oneOf'] as const) {
    if (Array.isArray(node[unionKey])) {
      node[unionKey].forEach((child) => visitSchemaNode(child, found));
    }
  }
}

function classifyProcessFailure(stderr: string): CodexCliSubscriptionError {
  const normalized = stderr.toLowerCase();
  if (
    normalized.includes('requires a newer version of codex') ||
    normalized.includes('error loading config.toml') ||
    normalized.includes('unknown field') ||
    normalized.includes('unexpected argument')
  ) {
    return new CodexCliSubscriptionError(
      'NOT_CONFIGURED',
      'Codex CLI 版本过旧或与当前配置不兼容，请更新到最新版 Codex CLI。',
    );
  }
  if (normalized.includes('not logged in') || normalized.includes('login required')) {
    return new CodexCliSubscriptionError('AUTH_REQUIRED', 'Codex 订阅尚未登录或登录已失效。');
  }
  if (
    normalized.includes('rate limit') ||
    normalized.includes('usage limit') ||
    normalized.includes('429')
  ) {
    return new CodexCliSubscriptionError('RATE_LIMITED', 'Codex 订阅暂时达到用量限制。');
  }
  return new CodexCliSubscriptionError('EXECUTION_FAILED', 'Codex CLI 执行失败。');
}

function classifyEventFailure(event: Record<string, unknown>): CodexCliSubscriptionError {
  const detail = extractEventErrorMessage(event);
  const normalized = detail.toLowerCase();
  if (normalized.includes('requires a newer version of codex')) {
    return new CodexCliSubscriptionError(
      'NOT_CONFIGURED',
      'Codex CLI 版本过旧，无法使用当前模型，请更新到最新版 Codex CLI。',
    );
  }
  if (normalized.includes('not logged in') || normalized.includes('login required')) {
    return new CodexCliSubscriptionError('AUTH_REQUIRED', 'Codex 订阅尚未登录或登录已失效。');
  }
  if (
    normalized.includes('rate limit') ||
    normalized.includes('usage limit') ||
    normalized.includes('429')
  ) {
    return new CodexCliSubscriptionError('RATE_LIMITED', 'Codex 订阅暂时达到用量限制。');
  }
  const diagnostic = sanitizeDiagnostic(detail);
  return new CodexCliSubscriptionError(
    'EXECUTION_FAILED',
    diagnostic ? `Codex 订阅调用失败：${diagnostic}` : 'Codex 订阅调用失败。',
  );
}

function extractEventErrorMessage(event: Record<string, unknown>): string {
  let value: unknown = event.message ?? event.error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (isRecord(value)) {
      value = value.message ?? value.error;
      continue;
    }
    if (typeof value !== 'string') return '';
    const text = value.trim();
    if (!text.startsWith('{')) return text;
    try {
      value = JSON.parse(text);
    } catch {
      return text;
    }
  }
  return typeof value === 'string' ? value : '';
}

function sanitizeDiagnostic(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\/(?:Users|home|root|private|tmp)\/[^\s"'`]+/g, '<path>')
    .replace(/\b(?:sk|sess|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, '<redacted>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
