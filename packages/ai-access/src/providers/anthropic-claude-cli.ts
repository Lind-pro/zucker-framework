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

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const STDERR_LIMIT = 8_192;
/** Upper bound for the single `--output-format json` result object. */
const STDOUT_LIMIT = 32 * 1024 * 1024;
/** One `stream-json` line larger than this is treated as invalid output. */
const STDOUT_LINE_LIMIT = 16 * 1024 * 1024;
const DEFAULT_INSTRUCTIONS = 'You are a helpful assistant. Answer the user request directly.';
/**
 * Variables the CLI needs to find its own login (HOME / CLAUDE_CONFIG_DIR), reach the
 * network and render text. Everything else, in particular ANTHROPIC_API_KEY and the
 * ANTHROPIC_BASE_URL family, is excluded: an API key would silently switch the CLI from
 * the subscription login to billed API usage.
 */
const SAFE_ENVIRONMENT_KEYS = new Set([
  'ALL_PROXY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LANG',
  'LC_ALL',
  'NODE_EXTRA_CA_CERTS',
  'NO_PROXY',
  'PATH',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'TEMP',
  'TMP',
  'TMPDIR',
  'TZ',
  'USER',
  'XDG_CONFIG_HOME',
]);
const CLAUDE_EFFORT: Partial<Record<NonNullable<AIAccessRequest['reasoningEffort']>, string>> = {
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
  ultra: 'max',
};

export type ClaudeCliSubscriptionErrorCode =
  | 'NOT_CONFIGURED'
  | 'SPAWN_FAILED'
  | 'AUTH_REQUIRED'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'EXECUTION_FAILED'
  | 'INVALID_OUTPUT';

export class ClaudeCliSubscriptionError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: ClaudeCliSubscriptionErrorCode,
    message: string,
    options: { cause?: unknown; retryable?: boolean } = {},
  ) {
    super(message, options.cause instanceof Error ? { cause: options.cause } : undefined);
    this.name = 'ClaudeCliSubscriptionError';
    this.retryable =
      options.retryable ?? ['RATE_LIMITED', 'TIMEOUT', 'EXECUTION_FAILED'].includes(code);
  }
}

export interface ClaudeCliCommand {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** The user prompt. It is written to stdin and never placed on the command line. */
  stdin: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** `json` parses one result object; `stream-json` also forwards text deltas. */
  outputFormat: 'json' | 'stream-json';
  onTextDelta?: AIAccessRequest['onTextDelta'];
}

export type ClaudeCliCommandRunner = (command: ClaudeCliCommand) => Promise<AIAccessResult>;

export interface AnthropicClaudeCliSubscriptionProviderOptions {
  /** Claude Code executable; resolved through PATH when not absolute. Default `claude`. */
  executable?: string;
  /**
   * Optional dedicated Claude Code configuration directory (`CLAUDE_CONFIG_DIR`) holding a
   * `claude login` session. Without it the CLI uses `$HOME/.claude`, so `HOME` must then
   * be supplied through `environment`.
   */
  configDir?: string;
  /** Empty private directory used as the CLI working directory (no project files). */
  workingDirectory: string;
  /** Allow-listed variables only (see SAFE_ENVIRONMENT_KEYS); API keys are rejected. */
  environment?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** System prompt used when a request has no instructions; replaces Claude Code's own. */
  defaultInstructions?: string;
  commandRunner?: ClaudeCliCommandRunner;
}

/**
 * Text inference through an installed, already logged-in Claude Code CLI (`claude -p`).
 * The CLI owns authentication; this adapter never reads or copies its tokens. Every call
 * runs without built-in tools, MCP servers, slash commands, user/project settings, hooks,
 * plugins, CLAUDE.md discovery or session persistence.
 */
export class AnthropicClaudeCliSubscriptionProvider {
  readonly id = 'anthropic-claude-cli';
  readonly name = 'Anthropic Claude Subscription CLI';
  private readonly executable: string;
  private readonly configDir?: string;
  private readonly workingDirectory: string;
  private readonly environment: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly defaultInstructions: string;
  private readonly commandRunner: ClaudeCliCommandRunner;

  constructor(options: AnthropicClaudeCliSubscriptionProviderOptions) {
    this.executable = options.executable?.trim() || 'claude';
    this.configDir = options.configDir?.trim()
      ? requireAbsolutePath(options.configDir, 'configDir')
      : undefined;
    this.workingDirectory = requireAbsolutePath(options.workingDirectory, 'workingDirectory');
    this.environment = buildEnvironment(options.environment, this.configDir);
    this.timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs');
    this.defaultInstructions = options.defaultInstructions?.trim() || DEFAULT_INSTRUCTIONS;
    this.commandRunner = options.commandRunner ?? runClaudeCliCommand;
  }

  async createModel(config: {
    modelId: string;
    timeoutMs?: number;
  }): Promise<AnthropicClaudeCliSubscriptionClient> {
    const modelId = config.modelId.trim();
    if (!modelId) {
      throw new ClaudeCliSubscriptionError('NOT_CONFIGURED', 'Claude 订阅模型 ID 不能为空。');
    }
    return new AnthropicClaudeCliSubscriptionClient({
      executable: this.executable,
      workingDirectory: this.workingDirectory,
      environment: this.environment,
      timeoutMs: positiveInteger(config.timeoutMs, this.timeoutMs, 'timeoutMs'),
      defaultInstructions: this.defaultInstructions,
      commandRunner: this.commandRunner,
      modelId,
    });
  }
}

export function createAnthropicClaudeCliAccessProvider(
  options: AnthropicClaudeCliSubscriptionProviderOptions,
): AIAccessProviderPlugin {
  const provider = new AnthropicClaudeCliSubscriptionProvider(options);
  const reference = options.configDir?.trim() || join(options.environment?.HOME ?? '~', '.claude');
  return {
    id: provider.id,
    name: provider.name,
    authMethods: [],
    credentialSources: [
      {
        id: 'claude-config-dir',
        label: 'Official Claude Code configuration directory',
        kind: 'file',
        ownership: 'external-readonly',
        discover: async (context) => {
          const now = Date.now();
          return [
            {
              id: credentialProfileId(provider.id, context.profileName),
              providerId: provider.id,
              profileName: context.profileName,
              authMethod: 'claude-cli-login',
              ownership: 'external-readonly',
              credential: { kind: 'external-reference', source: 'claude-config-dir', reference },
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

interface AnthropicClaudeCliSubscriptionClientOptions {
  executable: string;
  workingDirectory: string;
  environment: Record<string, string>;
  timeoutMs: number;
  defaultInstructions: string;
  commandRunner: ClaudeCliCommandRunner;
  modelId: string;
}

export class AnthropicClaudeCliSubscriptionClient {
  constructor(private readonly options: AnthropicClaudeCliSubscriptionClientOptions) {}

  async complete(
    request: Omit<AIAccessRequest, 'model'> & { model?: string },
  ): Promise<AIAccessResult> {
    const model = request.model?.trim() || this.options.modelId;
    const input = request.input.trim();
    if (!input) {
      throw new ClaudeCliSubscriptionError('NOT_CONFIGURED', 'Claude 订阅调用输入不能为空。');
    }
    if (request.imageGeneration) {
      throw new ClaudeCliSubscriptionError('NOT_CONFIGURED', 'Claude CLI 订阅不支持图片生成。');
    }
    let schemaArg: string | undefined;
    if (request.outputSchema !== undefined) {
      if (!isRecord(request.outputSchema)) {
        throw new ClaudeCliSubscriptionError('NOT_CONFIGURED', 'Claude outputSchema 必须是 JSON 对象。');
      }
      schemaArg = JSON.stringify(request.outputSchema);
    }
    request.signal?.throwIfAborted();

    // The system prompt goes through a private file instead of argv: it may be large and
    // argv is visible to other local users. The directory is removed after the call.
    const directory = await mkdtemp(join(tmpdir(), 'zucker-claude-cli-'));
    try {
      const systemPromptFile = join(directory, 'system-prompt.txt');
      await writeFile(systemPromptFile, request.instructions?.trim() || this.options.defaultInstructions, {
        encoding: 'utf8',
        mode: 0o600,
      });
      const outputFormat = request.onTextDelta ? 'stream-json' : 'json';
      const args = buildArgs({
        model,
        outputFormat,
        systemPromptFile,
        effort: request.reasoningEffort ? CLAUDE_EFFORT[request.reasoningEffort] : undefined,
        schema: schemaArg,
      });
      return await this.options.commandRunner({
        executable: this.options.executable,
        args,
        cwd: this.options.workingDirectory,
        env: { ...this.options.environment },
        stdin: input,
        timeoutMs: this.options.timeoutMs,
        signal: request.signal,
        outputFormat,
        onTextDelta: request.onTextDelta,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function buildArgs(input: {
  model: string;
  outputFormat: 'json' | 'stream-json';
  systemPromptFile: string;
  effort?: string;
  schema?: string;
}): string[] {
  const args = [
    '-p',
    '--output-format',
    input.outputFormat,
    ...(input.outputFormat === 'stream-json' ? ['--verbose', '--include-partial-messages'] : []),
    '--model',
    input.model,
    '--system-prompt-file',
    input.systemPromptFile,
    // Isolation: no built-in tools, no MCP servers, no slash commands/skills, no user or
    // project settings (and so no settings env/hooks), safe mode for plugins/CLAUDE.md,
    // and nothing written to the session history. `--bare` is deliberately not used: it
    // disables OAuth, i.e. the subscription login this adapter exists for.
    '--tools',
    '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--setting-sources',
    '',
    '--safe-mode',
    '--no-session-persistence',
  ];
  if (input.effort) args.push('--effort', input.effort);
  if (input.schema) args.push('--json-schema', input.schema);
  return args;
}

async function runClaudeCliCommand(command: ClaudeCliCommand): Promise<AIAccessResult> {
  if (command.signal?.aborted) {
    throw new ClaudeCliSubscriptionError('CANCELLED', 'Claude 订阅调用已取消。');
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
      reject(new ClaudeCliSubscriptionError('SPAWN_FAILED', '无法启动 Claude CLI。', { cause: error }));
      return;
    }

    const streaming = command.outputFormat === 'stream-json';
    let settled = false;
    let cancelled = false;
    let timedOut = false;
    let stderr = '';
    let stdout = '';
    let resultEvent: Record<string, unknown> | undefined;
    let streamError: ClaudeCliSubscriptionError | undefined;
    // Deltas are delivered in order and awaited; a callback failure stops the attempt.
    let deltas: Promise<void> = Promise.resolve();

    const terminate = () => {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 5_000);
      killTimer.unref?.();
    };
    const failStream = (error: ClaudeCliSubscriptionError) => {
      streamError ??= error;
      terminate();
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
    const fail = (error: ClaudeCliSubscriptionError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const parseStreamLine = (line: string) => {
      if (!line.trim() || streamError) return;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch (error) {
        failStream(new ClaudeCliSubscriptionError('INVALID_OUTPUT', 'Claude CLI 返回了无效 stream-json。', { cause: error }));
        return;
      }
      if (!isRecord(event)) return;
      if (event.type === 'result') {
        resultEvent = event;
      } else if (event.type === 'assistant' && hasToolUse(event)) {
        // Tools are disabled; any tool use means the isolation did not hold.
        failStream(new ClaudeCliSubscriptionError('EXECUTION_FAILED', 'Unexpected tool activity during text inference.'));
      } else if (event.type === 'stream_event' && isRecord(event.event)) {
        const inner = event.event;
        if (inner.type === 'content_block_delta' && isRecord(inner.delta)
          && inner.delta.type === 'text_delta' && typeof inner.delta.text === 'string' && inner.delta.text) {
          const text = inner.delta.text;
          const onTextDelta = command.onTextDelta;
          if (onTextDelta) {
            deltas = deltas.then(async () => {
              if (streamError) return;
              try {
                await onTextDelta(text);
              } catch (error) {
                failStream(new ClaudeCliSubscriptionError('EXECUTION_FAILED', 'Claude 文本增量处理失败。', { cause: error, retryable: false }));
              }
            });
          }
        }
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (streamError) return;
      stdout += chunk;
      if (streaming) {
        for (;;) {
          const newline = stdout.indexOf('\n');
          if (newline < 0) break;
          parseStreamLine(stdout.slice(0, newline));
          stdout = stdout.slice(newline + 1);
        }
        if (stdout.length > STDOUT_LINE_LIMIT) {
          stdout = '';
          failStream(new ClaudeCliSubscriptionError('INVALID_OUTPUT', 'Claude CLI 输出行超过大小限制。'));
        }
      } else if (stdout.length > STDOUT_LIMIT) {
        stdout = '';
        failStream(new ClaudeCliSubscriptionError('INVALID_OUTPUT', 'Claude CLI 输出超过大小限制。'));
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < STDERR_LIMIT) stderr += chunk.slice(0, STDERR_LIMIT - stderr.length);
    });
    child.once('error', (error) => {
      fail(new ClaudeCliSubscriptionError('SPAWN_FAILED', '无法启动 Claude CLI。', { cause: error }));
    });
    child.once('close', (code) => {
      if (settled) return;
      void (async () => {
        if (streaming) {
          if (stdout.trim()) parseStreamLine(stdout);
          await deltas;
        } else if (!streamError && stdout.trim()) {
          try {
            const parsed: unknown = JSON.parse(stdout);
            if (isRecord(parsed) && parsed.type === 'result') resultEvent = parsed;
            else streamError = new ClaudeCliSubscriptionError('INVALID_OUTPUT', 'Claude CLI 未返回结果对象。');
          } catch (error) {
            streamError = new ClaudeCliSubscriptionError('INVALID_OUTPUT', 'Claude CLI 返回了无效 JSON。', { cause: error });
          }
        }
        if (cancelled) return fail(new ClaudeCliSubscriptionError('CANCELLED', 'Claude 订阅调用已取消。'));
        if (timedOut) return fail(new ClaudeCliSubscriptionError('TIMEOUT', 'Claude 订阅调用超时。'));
        if (streamError) return fail(streamError);
        // The CLI reports API/auth failures inside the result object (often with exit code 1).
        if (resultEvent) {
          const outcome = interpretResult(resultEvent);
          if (outcome instanceof ClaudeCliSubscriptionError) return fail(outcome);
          settled = true;
          cleanup();
          resolve(outcome);
          return;
        }
        if (code !== 0) return fail(classifyFailure(stderr));
        fail(new ClaudeCliSubscriptionError('INVALID_OUTPUT', 'Claude CLI 未返回结果对象及实际用量。'));
      })();
    });

    child.stdin.once('error', () => terminate());
    child.stdin.end(command.stdin);
  });
}

function interpretResult(event: Record<string, unknown>): AIAccessResult | ClaudeCliSubscriptionError {
  const text = typeof event.result === 'string' ? event.result : '';
  if (event.is_error === true || (typeof event.subtype === 'string' && event.subtype !== 'success')) {
    const status = typeof event.api_error_status === 'number' ? event.api_error_status : undefined;
    return classifyFailure(text || stringValue(event.subtype) || '', status);
  }
  const usage = isRecord(event.usage) ? event.usage : undefined;
  const directInput = nonNegativeInteger(usage?.input_tokens);
  const output = nonNegativeInteger(usage?.output_tokens);
  const cacheRead = usage?.cache_read_input_tokens === undefined ? 0 : nonNegativeInteger(usage.cache_read_input_tokens);
  const cacheCreation = usage?.cache_creation_input_tokens === undefined ? 0 : nonNegativeInteger(usage.cache_creation_input_tokens);
  if (directInput === undefined || output === undefined || cacheRead === undefined || cacheCreation === undefined) {
    return new ClaudeCliSubscriptionError('INVALID_OUTPUT', 'Claude CLI 结果的用量无效。');
  }
  // `input` counts every prompt token the model processed, cached or not, so usage logs
  // compare with other providers; the cache split is reported separately.
  const input = directInput + cacheRead + cacheCreation;
  if (!Number.isSafeInteger(input + output)) {
    return new ClaudeCliSubscriptionError('INVALID_OUTPUT', 'Claude CLI 结果的用量无效。');
  }
  const content = event.structured_output !== undefined && event.structured_output !== null
    ? JSON.stringify(event.structured_output)
    : text.trim();
  if (!content) {
    return new ClaudeCliSubscriptionError('INVALID_OUTPUT', 'Claude CLI 未返回最终答案。');
  }
  const model = isRecord(event.modelUsage) ? Object.keys(event.modelUsage)[0] : undefined;
  const responseId = stringValue(event.session_id);
  return {
    content,
    finishReason: stringValue(event.stop_reason) ?? 'completed',
    ...(responseId ? { responseId } : {}),
    ...(model ? { model } : {}),
    tokenUsage: {
      input,
      output,
      total: input + output,
      cacheReadInput: cacheRead,
      cacheCreationInput: cacheCreation,
    },
  };
}

function hasToolUse(event: Record<string, unknown>): boolean {
  const message = isRecord(event.message) ? event.message : undefined;
  return Array.isArray(message?.content)
    && message.content.some((block) => isRecord(block) && (block.type === 'tool_use' || block.type === 'server_tool_use'));
}

function classifyFailure(detail: string, status?: number): ClaudeCliSubscriptionError {
  const normalized = detail.toLowerCase();
  if (
    normalized.includes('unknown option') ||
    normalized.includes('invalid setting source') ||
    normalized.includes('system prompt file not found')
  ) {
    return new ClaudeCliSubscriptionError(
      'NOT_CONFIGURED',
      'Claude CLI 版本过旧或与当前参数不兼容，请更新 Claude Code。',
    );
  }
  if (
    status === 401 ||
    status === 403 ||
    normalized.includes('not logged in') ||
    normalized.includes('please run /login') ||
    normalized.includes('invalid api key') ||
    normalized.includes('oauth token') ||
    normalized.includes('authentication')
  ) {
    return new ClaudeCliSubscriptionError('AUTH_REQUIRED', 'Claude 订阅尚未登录或登录已失效。');
  }
  if (
    status === 429 ||
    normalized.includes('rate limit') ||
    normalized.includes('usage limit') ||
    normalized.includes('limit reached') ||
    normalized.includes('429')
  ) {
    return new ClaudeCliSubscriptionError('RATE_LIMITED', 'Claude 订阅暂时达到用量限制。');
  }
  const diagnostic = sanitizeDiagnostic(detail);
  return new ClaudeCliSubscriptionError(
    'EXECUTION_FAILED',
    diagnostic ? `Claude 订阅调用失败：${diagnostic}` : 'Claude CLI 执行失败。',
  );
}

function buildEnvironment(
  input: Record<string, string | undefined> | undefined,
  configDir: string | undefined,
): Record<string, string> {
  const environment: Record<string, string> = {
    // Service use: no auto-updater, telemetry or other non-essential traffic.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  for (const [key, value] of Object.entries(input ?? {})) {
    if (!SAFE_ENVIRONMENT_KEYS.has(key)) {
      throw new ClaudeCliSubscriptionError('NOT_CONFIGURED', `Claude 订阅子进程环境不允许注入 ${key}。`);
    }
    if (value !== undefined) environment[key] = value;
  }
  if (configDir) environment.CLAUDE_CONFIG_DIR = configDir;
  if (!environment.CLAUDE_CONFIG_DIR && !environment.HOME) {
    throw new ClaudeCliSubscriptionError(
      'NOT_CONFIGURED',
      'Claude 订阅需要 configDir 或 environment.HOME 以定位 CLI 登录。',
    );
  }
  return environment;
}

function requireAbsolutePath(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized || !isAbsolute(normalized)) {
    throw new ClaudeCliSubscriptionError('NOT_CONFIGURED', `Claude 订阅 ${name} 必须是绝对路径。`);
  }
  return normalized;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new ClaudeCliSubscriptionError('NOT_CONFIGURED', `Claude 订阅 ${name} 必须是正整数。`);
  }
  return value;
}

function sanitizeDiagnostic(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\/(?:Users|home|root|private|tmp)\/[^\s"'`]+/g, '<path>')
    .replace(/\b(?:sk-ant|sk|sess|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, '<redacted>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
