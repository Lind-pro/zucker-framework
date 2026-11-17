import { spawn } from 'node:child_process';
import type { AIAccessRequest, AIAccessResult } from '../contracts';
import { codexInferenceConfigArgs } from './codex-inference-config';
import { CodexCliSubscriptionError } from './openai-codex-cli';

export interface CodexAppServerCommand {
  executable: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  request: AIAccessRequest;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const tokens = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** One ephemeral inference, with no credential copy or independent refresh lifecycle. */
export async function runCodexAppServer(command: CodexAppServerCommand): Promise<AIAccessResult> {
  const { request } = command;
  if (request.signal?.aborted)
    throw new CodexCliSubscriptionError('CANCELLED', 'Codex subscription call cancelled.');
  const args = ['app-server', '--stdio', '--strict-config', ...codexInferenceConfigArgs(), ...(request.imageGeneration ? ['--config', 'features.image_generation=true'] : [])];

  return new Promise<AIAccessResult>((resolve, reject) => {
    const child = spawn(command.executable, args, {
      cwd: command.cwd,
      env: command.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let settled = false;
    let buffer = '';
    let diagnostics = '';
    let serial = Promise.resolve();
    let threadId: string | undefined;
    let turnId: string | undefined;
    let content = '';
    const images: NonNullable<AIAccessResult['images']> = [];
    let usage: AIAccessResult['tokenUsage'] | undefined;
    let receivedDelta = false;
    const phases = new Map<string, unknown>();
    const answers = new Map<string, string>();
    const stop = () => {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      const kill = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 1000);
      kill.unref?.();
    };
    const cleanup = () => {
      clearTimeout(timeout);
      request.signal?.removeEventListener('abort', abort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      stop();
      reject(error);
    };
    const abort = () =>
      fail(new CodexCliSubscriptionError('CANCELLED', 'Codex subscription call cancelled.'));
    const timeout = setTimeout(
      () => fail(new CodexCliSubscriptionError('TIMEOUT', 'Codex subscription call timed out.')),
      command.timeoutMs,
    );
    timeout.unref?.();
    request.signal?.addEventListener('abort', abort, { once: true });
    const send = (method: string, params: unknown, id?: number) => {
      if (!settled)
        child.stdin.write(
          JSON.stringify({ method, params, ...(id === undefined ? {} : { id }) }) + '\n',
        );
    };
    const invalid = (message: string) => new CodexCliSubscriptionError('INVALID_OUTPUT', message);
    const handle = async (line: string) => {
      if (settled || !line.trim()) return;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        throw invalid('Codex app server returned invalid JSONL.');
      }
      if (!record(message)) throw invalid('Codex app server returned an invalid event.');
      if (record(message.error)) {
        const code = message.error.code;
        throw new CodexCliSubscriptionError(
          'EXECUTION_FAILED',
          `Codex app server request failed (${typeof code === 'number' ? code : 'unknown'}).`,
        );
      }
      if (typeof message.id === 'number' && record(message.result)) {
        if (message.id === 0) {
          send('initialized', {});
          // Inspect effective configuration in memory, then disable every configured
          // external capability before creating a thread. Never log config values.
          send('config/read', { includeLayers: false, cwd: command.cwd }, 1);
        } else if (message.id === 1) {
          const config: Record<string, unknown> = {
            'features.hooks': false,
            'features.image_generation': request.imageGeneration === true,
            web_search: 'disabled',
            'tools.web_search': false,
            'apps._default.enabled': false,
            project_doc_max_bytes: 0,
          };
          const current = message.result.config;
          if (!record(current)) throw invalid('Codex app server did not return its configuration.');
          for (const group of ['mcp_servers', 'apps', 'plugins']) {
            const entries = current[group];
            if (!record(entries)) continue;
            for (const name of Object.keys(entries)) {
              const key = /^[a-zA-Z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
              config[`${group}.${key}.enabled`] = false;
            }
          }
          if (request.textVerbosity) config.model_verbosity = request.textVerbosity;
          send(
            'thread/start',
            {
              model: request.model,
              cwd: command.cwd,
              approvalPolicy: 'never',
              permissions: 'subscription_inference',
              ephemeral: true,
              config,
              baseInstructions: request.instructions ?? '',
              developerInstructions: '',
              dynamicTools: [],
              selectedCapabilityRoots: [],
              environments: [],
            },
            2,
          );
        } else if (message.id === 2) {
          if (!record(message.result.thread) || typeof message.result.thread.id !== 'string')
            throw invalid('Codex app server did not create a thread.');
          threadId = message.result.thread.id;
          send(
            'turn/start',
            {
              threadId,
              model: request.model,
              input: [{ type: 'text', text: request.input }],
              approvalPolicy: 'never',
              permissions: 'subscription_inference',
              environments: [],
              ...(request.reasoningEffort && request.reasoningEffort !== 'none'
                ? { effort: request.reasoningEffort }
                : {}),
              ...(request.outputSchema !== undefined ? { outputSchema: request.outputSchema } : {}),
            },
            3,
          );
        } else if (
          message.id === 3 &&
          record(message.result.turn) &&
          typeof message.result.turn.id === 'string'
        ) {
          turnId = message.result.turn.id;
        }
        return;
      }
      // This adapter is text-only. It never grants approval or executes client tools.
      if (message.id !== undefined && typeof message.method === 'string')
        throw new CodexCliSubscriptionError(
          'EXECUTION_FAILED',
          'Unexpected tool or approval request during text inference.',
        );
      const params = message.params;
      if (!record(params) || params.threadId !== threadId) return;
      if (turnId && params.turnId !== undefined && params.turnId !== turnId) return;
      if (
        message.method === 'turn/started' &&
        record(params.turn) &&
        typeof params.turn.id === 'string'
      )
        turnId = params.turn.id;
      if (message.method === 'item/started' && record(params.item)) {
        const item = params.item;
        if (item.type === 'imageGeneration' && !request.imageGeneration) throw invalid('Unexpected image generation during text inference.');
        if (item.type === 'agentMessage' && typeof item.id === 'string')
          phases.set(item.id, item.phase);
        if (
          [
            'commandExecution',
            'fileChange',
            'mcpToolCall',
            'dynamicToolCall',
            'webSearch',
            'collabAgentToolCall',
          ].includes(String(item.type))
        )
          throw new CodexCliSubscriptionError(
            'EXECUTION_FAILED',
            'Unexpected tool activity during text inference.',
          );
      } else if (message.method === 'item/agentMessage/delta') {
        if (typeof params.delta !== 'string' || typeof params.itemId !== 'string')
          throw invalid('Invalid answer delta.');
        if (phases.get(params.itemId) === 'commentary') return;
        if (params.delta) {
          receivedDelta = true;
          answers.set(params.itemId, (answers.get(params.itemId) ?? '') + params.delta);
          await request.onTextDelta?.(params.delta);
        }
      } else if (message.method === 'item/completed' && record(params.item)) {
        const item = params.item;
        if (item.type === 'imageGeneration') {
          if (!request.imageGeneration) throw invalid('Unexpected image generation during text inference.');
          if (images.length) throw invalid('Codex returned multiple images for a single-image request.');
          if (item.status !== 'completed' || item.failure) throw invalid('Codex image generation did not complete successfully.');
          if (typeof item.result !== 'string') throw invalid('Codex completed image generation without inline image bytes.');
          // Never read a model-supplied path or fetch an untrusted attachment URL.
          const data = item.result.replace(/^data:image\/png;base64,/, '');
          if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 || data.length > 16 * 1024 * 1024) throw invalid('Invalid generated image encoding.');
          const bytes = Buffer.from(data, 'base64');
          if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw invalid('Generated image is not PNG.');
          images.push({ data, mimeType: 'image/png', ...(typeof item.revisedPrompt === 'string' ? { revisedPrompt: item.revisedPrompt } : {}) });
        }
        if (
          item.type === 'agentMessage' &&
          item.phase !== 'commentary' &&
          typeof item.text === 'string'
        ) {
          if ((!request.imageGeneration || item.text) && (typeof item.id !== 'string' || answers.get(item.id) !== item.text))
            throw invalid('Completed answer differs from the streamed answer.');
          content = item.text;
        }
      } else if (message.method === 'thread/tokenUsage/updated' && record(params.tokenUsage)) {
        const total = params.tokenUsage.total;
        if (
          !record(total) ||
          !tokens(total.inputTokens) ||
          !tokens(total.outputTokens) ||
          !Number.isSafeInteger(total.inputTokens + total.outputTokens)
        )
          throw invalid('Codex app server returned invalid token usage.');
        usage = {
          input: total.inputTokens,
          output: total.outputTokens,
          total: total.inputTokens + total.outputTokens,
        };
      } else if (message.method === 'turn/completed') {
        if (!record(params.turn) || params.turn.status !== 'completed')
          throw new CodexCliSubscriptionError(
            params.turn && record(params.turn) && params.turn.status === 'interrupted'
              ? 'CANCELLED'
              : 'EXECUTION_FAILED',
            'Codex turn did not complete.',
          );
        if (!usage || (request.imageGeneration ? images.length !== 1 : !receivedDelta || !content.trim()))
          throw invalid(
            'Codex app server did not return a complete streamed answer and token usage.',
          );
        settled = true;
        cleanup();
        stop();
        resolve({
          content: content.trim(),
          ...(request.imageGeneration ? { images } : {}),
          finishReason: 'completed',
          responseId: threadId,
          tokenUsage: usage,
        });
      } else if (message.method === 'error' && params.willRetry !== true) {
        throw new CodexCliSubscriptionError(
          'EXECUTION_FAILED',
          'Codex app server inference failed.',
        );
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 16 * 1024 * 1024) {
        fail(invalid('Codex app server event is too large.'));
        return;
      }
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        serial = serial.then(() => handle(line)).catch(fail);
      }
    });
    // Retain a bounded diagnostic in memory. Only an allowlisted configuration
    // field name may enter the error; never echo arbitrary process stderr.
    child.stderr.on('data', (chunk: Buffer) => {
      if (diagnostics.length < 8192)
        diagnostics += chunk.toString('utf8').slice(0, 8192 - diagnostics.length);
    });
    child.once('error', (error) =>
      fail(
        new CodexCliSubscriptionError('SPAWN_FAILED', 'Could not start Codex app server.', {
          cause: error,
        }),
      ),
    );
    child.stdin.on('error', (error) =>
      fail(
        new CodexCliSubscriptionError('EXECUTION_FAILED', 'Codex app server input closed.', {
          cause: error,
        }),
      ),
    );
    child.once('close', () => {
      void serial.then(() => {
        if (!settled) {
          const unsupported = diagnostics.match(/unknown configuration field `([a-zA-Z0-9_.-]+)`/);
          fail(
            unsupported
              ? new CodexCliSubscriptionError(
                  'NOT_CONFIGURED',
                  `Codex app server does not support configuration field ${unsupported[1]}.`,
                )
              : invalid('Codex app server closed before completing the turn.'),
          );
        }
      });
    });
    send(
      'initialize',
      {
        clientInfo: { name: 'zucker-ai-access', version: '1' },
        capabilities: { experimentalApi: true },
      },
      0,
    );
  });
}
