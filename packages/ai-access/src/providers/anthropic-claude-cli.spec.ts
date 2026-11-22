// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AnthropicClaudeCliSubscriptionProvider,
  ClaudeCliSubscriptionError,
  createAnthropicClaudeCliAccessProvider,
  type ClaudeCliCommand,
} from './anthropic-claude-cli';

const success = (overrides: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'final answer',
  stop_reason: 'end_turn',
  session_id: 'session-1',
  usage: { input_tokens: 2, cache_creation_input_tokens: 500, cache_read_input_tokens: 100, output_tokens: 4 },
  modelUsage: { 'claude-synthetic-5': { inputTokens: 2, outputTokens: 4 } },
  ...overrides,
});

describe('AnthropicClaudeCliSubscriptionProvider', () => {
  it('runs claude -p isolated, with the prompt on stdin and the system prompt in a private file', async () => {
    let systemPrompt = '';
    const commandRunner = vi.fn(async (command: ClaudeCliCommand) => {
      const file = command.args[command.args.indexOf('--system-prompt-file') + 1]!;
      systemPrompt = await readFile(file, 'utf8');
      return { content: 'ok', finishReason: 'end_turn', tokenUsage: { input: 1, output: 1, total: 2 } };
    });
    const provider = new AnthropicClaudeCliSubscriptionProvider({
      executable: '/opt/claude/bin/claude',
      configDir: '/run/secrets/claude-config',
      workingDirectory: '/tmp/claude-inference',
      environment: { PATH: '/usr/bin:/bin', HTTPS_PROXY: 'https://proxy.example.test' },
      commandRunner,
    });
    const client = await provider.createModel({ modelId: 'sonnet', timeoutMs: 120_000 });

    await expect(client.complete({
      instructions: '只返回最终答案。',
      input: '分析这段技术方案。',
      reasoningEffort: 'ultra',
    })).resolves.toMatchObject({ content: 'ok' });

    const command = commandRunner.mock.calls[0]![0];
    expect(command.executable).toBe('/opt/claude/bin/claude');
    expect(command.cwd).toBe('/tmp/claude-inference');
    expect(command.timeoutMs).toBe(120_000);
    expect(command.outputFormat).toBe('json');
    expect(command.stdin).toBe('分析这段技术方案。');
    expect(systemPrompt).toBe('只返回最终答案。');
    expect(command.env).toEqual({
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CONFIG_DIR: '/run/secrets/claude-config',
      PATH: '/usr/bin:/bin',
      HTTPS_PROXY: 'https://proxy.example.test',
    });
    const args = command.args;
    expect(args.slice(0, 3)).toEqual(['-p', '--output-format', 'json']);
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
    expect(args[args.indexOf('--effort') + 1]).toBe('max');
    expect(args).toEqual(expect.arrayContaining([
      '--strict-mcp-config', '--disable-slash-commands', '--safe-mode', '--no-session-persistence',
    ]));
    expect(args).not.toContain('--bare');
    expect(args).not.toContain('--mcp-config');
    expect(args).not.toContain('--json-schema');
    expect(args.join(' ')).not.toContain('技术方案');
    expect(args.join(' ')).not.toContain('只返回最终答案');
    // The private system-prompt directory does not outlive the call.
    await expect(readFile(args[args.indexOf('--system-prompt-file') + 1]!, 'utf8')).rejects.toThrow();
  });

  it('replaces the Claude Code system prompt even without instructions and maps none effort to the default', async () => {
    let systemPrompt = '';
    const commandRunner = vi.fn(async (command: ClaudeCliCommand) => {
      systemPrompt = await readFile(command.args[command.args.indexOf('--system-prompt-file') + 1]!, 'utf8');
      return { content: 'ok', finishReason: 'end_turn', tokenUsage: { input: 1, output: 1, total: 2 } };
    });
    const provider = new AnthropicClaudeCliSubscriptionProvider({
      workingDirectory: '/tmp/claude-inference', environment: { HOME: '/home/service' },
      defaultInstructions: 'Neutral assistant.', commandRunner,
    });
    const client = await provider.createModel({ modelId: 'sonnet' });
    await client.complete({ input: 'hi', reasoningEffort: 'none' });
    expect(systemPrompt).toBe('Neutral assistant.');
    expect(commandRunner.mock.calls[0]![0].args).not.toContain('--effort');
    expect(commandRunner.mock.calls[0]![0].executable).toBe('claude');
  });

  it('passes an output schema to --json-schema and streams with stream-json', async () => {
    const commandRunner = vi.fn(async (_command: ClaudeCliCommand) => ({
      content: '{}', finishReason: 'end_turn', tokenUsage: { input: 1, output: 1, total: 2 },
    }));
    const provider = new AnthropicClaudeCliSubscriptionProvider({
      workingDirectory: '/tmp/claude-inference', environment: { HOME: '/home/service' }, commandRunner,
    });
    const client = await provider.createModel({ modelId: 'sonnet' });
    const schema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] };
    const onTextDelta = vi.fn();
    await client.complete({ input: 'hi', outputSchema: schema, onTextDelta });
    const command = commandRunner.mock.calls[0]![0];
    expect(command.args[command.args.indexOf('--json-schema') + 1]).toBe(JSON.stringify(schema));
    expect(command.outputFormat).toBe('stream-json');
    expect(command.args).toEqual(expect.arrayContaining(['stream-json', '--verbose', '--include-partial-messages']));
    expect(command.onTextDelta).toBe(onTextDelta);
    await expect(client.complete({ input: 'x', outputSchema: 'nope' })).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    await expect(client.complete({ input: 'x', imageGeneration: true })).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    await expect(client.complete({ input: '  ' })).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });

  it('rejects API keys and unknown variables in the subscription environment and requires a login location', () => {
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDECODE']) {
      expect(() => new AnthropicClaudeCliSubscriptionProvider({
        workingDirectory: '/tmp/claude-inference', environment: { HOME: '/home/service', [key]: 'secret' },
      })).toThrow(key);
    }
    expect(() => new AnthropicClaudeCliSubscriptionProvider({ workingDirectory: '/tmp/claude-inference' }))
      .toThrow(ClaudeCliSubscriptionError);
    expect(() => new AnthropicClaudeCliSubscriptionProvider({
      workingDirectory: 'relative', environment: { HOME: '/home/service' },
    })).toThrow('workingDirectory');
    expect(() => new AnthropicClaudeCliSubscriptionProvider({
      workingDirectory: '/tmp/x', configDir: 'relative',
    })).toThrow('configDir');
  });

  it('exposes the CLI login as an external read-only reference through the registry contract', async () => {
    const plugin = createAnthropicClaudeCliAccessProvider({
      configDir: '/run/secrets/claude-config', workingDirectory: '/tmp/claude-inference', commandRunner: vi.fn(),
    });
    expect(plugin.id).toBe('anthropic-claude-cli');
    expect(plugin.authMethods).toEqual([]);
    await expect(plugin.credentialSources[0]!.discover({ profileName: 'sample' })).resolves.toEqual([
      expect.objectContaining({
        providerId: 'anthropic-claude-cli', ownership: 'external-readonly',
        credential: { kind: 'external-reference', source: 'claude-config-dir', reference: '/run/secrets/claude-config' },
      }),
    ]);
  });
});

describe('Claude CLI process runner', () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'zucker-claude-cli-test-')); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  async function fakeClaude(body: string[]): Promise<string> {
    const executable = join(directory, 'fake-claude');
    await writeFile(executable, ['#!/usr/bin/env node', ...body].join('\n'), { mode: 0o700 });
    return executable;
  }
  async function client(executable: string, timeoutMs?: number) {
    const provider = new AnthropicClaudeCliSubscriptionProvider({
      executable, workingDirectory: directory, environment: { PATH: process.env.PATH, HOME: directory }, timeoutMs,
    });
    return provider.createModel({ modelId: 'sonnet' });
  }
  const emitOnEnd = (payload: string, exitCode = 0) => [
    "let input = '';",
    "process.stdin.on('data', (c) => { input += c; });",
    `process.stdin.on('end', () => { process.stdout.write(${payload}); process.exitCode = ${exitCode}; });`,
  ];

  it('parses the json result object, including cache usage, model and stop reason', async () => {
    const executable = await fakeClaude(emitOnEnd(`JSON.stringify(Object.assign(${JSON.stringify(success())}, { result: 'echo:' + input }))`));
    await expect((await client(executable)).complete({ input: 'hello' })).resolves.toEqual({
      content: 'echo:hello',
      finishReason: 'end_turn',
      responseId: 'session-1',
      model: 'claude-synthetic-5',
      tokenUsage: { input: 602, output: 4, total: 606, cacheReadInput: 100, cacheCreationInput: 500 },
    });
  });

  it('uses structured_output when the CLI validated a JSON schema', async () => {
    const executable = await fakeClaude(emitOnEnd(JSON.stringify(JSON.stringify(success({ result: '', structured_output: { summary: 'ok' } })))));
    await expect((await client(executable)).complete({ input: 'x', outputSchema: { type: 'object' } }))
      .resolves.toMatchObject({ content: '{"summary":"ok"}' });
  });

  it.each([
    { name: 'auth failure', result: success({ is_error: true, subtype: 'success', result: 'Not logged in · Please run /login', api_error_status: null }), exit: 1, code: 'AUTH_REQUIRED' },
    { name: '401', result: success({ is_error: true, result: 'Invalid bearer token', api_error_status: 401 }), exit: 1, code: 'AUTH_REQUIRED' },
    { name: 'usage window', result: success({ is_error: true, result: 'Claude usage limit reached', api_error_status: 429 }), exit: 1, code: 'RATE_LIMITED' },
    { name: 'error subtype', result: success({ subtype: 'error_during_execution', result: undefined }), exit: 1, code: 'EXECUTION_FAILED' },
    { name: 'missing usage', result: success({ usage: { input_tokens: 2 } }), exit: 0, code: 'INVALID_OUTPUT' },
    { name: 'fractional usage', result: success({ usage: { input_tokens: 2.5, output_tokens: 1 } }), exit: 0, code: 'INVALID_OUTPUT' },
    { name: 'empty answer', result: success({ result: '  ' }), exit: 0, code: 'INVALID_OUTPUT' },
    { name: 'not a result object', result: { type: 'assistant' }, exit: 0, code: 'INVALID_OUTPUT' },
  ])('classifies $name as $code', async ({ result, exit, code }) => {
    const executable = await fakeClaude(emitOnEnd(JSON.stringify(JSON.stringify(result)), exit));
    await expect((await client(executable)).complete({ input: 'x' })).rejects.toMatchObject({ code });
  });

  it('reports invalid JSON and CLI flag incompatibility explicitly', async () => {
    const invalid = await fakeClaude(emitOnEnd("'not json'"));
    await expect((await client(invalid)).complete({ input: 'x' })).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    const old = await fakeClaude(["process.stderr.write(\"error: unknown option '--safe-mode'\\n\");", 'process.exit(1);']);
    await expect((await client(old)).complete({ input: 'x' })).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });

  it('forwards stream-json text deltas in order and settles on the final result', async () => {
    const events = [
      { type: 'system', subtype: 'init' },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hidden' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } },
      success({ result: 'Hello' }),
    ];
    const executable = await fakeClaude([
      'process.stdin.resume();',
      `process.stdin.on('end', () => ${JSON.stringify(events)}.forEach((e) => process.stdout.write(JSON.stringify(e) + '\\n')));`,
    ]);
    const seen: string[] = [];
    const result = await (await client(executable)).complete({
      input: 'x',
      onTextDelta: async (delta) => { await new Promise((r) => setTimeout(r, 5)); seen.push(delta); },
    });
    expect(seen).toEqual(['Hel', 'lo']);
    expect(result).toMatchObject({ content: 'Hello', tokenUsage: { total: 606 } });
  });

  it('stops on tool activity or a failing delta callback', async () => {
    const toolEvents = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
      success(),
    ];
    const tool = await fakeClaude([
      'process.stdin.resume();',
      `process.stdin.on('end', () => ${JSON.stringify(toolEvents)}.forEach((e) => process.stdout.write(JSON.stringify(e) + '\\n')));`,
    ]);
    await expect((await client(tool)).complete({ input: 'x', onTextDelta: vi.fn() }))
      .rejects.toMatchObject({ code: 'EXECUTION_FAILED' });

    const deltaEvents = [
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'a' } } },
      success(),
    ];
    const deltas = await fakeClaude([
      'process.stdin.resume();',
      `process.stdin.on('end', () => ${JSON.stringify(deltaEvents)}.forEach((e) => process.stdout.write(JSON.stringify(e) + '\\n')));`,
    ]);
    await expect((await client(deltas)).complete({ input: 'x', onTextDelta: () => { throw new Error('sink closed'); } }))
      .rejects.toMatchObject({ code: 'EXECUTION_FAILED', retryable: false });
  });

  it('kills the child on abort and on timeout', async () => {
    const hang = await fakeClaude(['process.stdin.resume();', 'setInterval(() => {}, 1000);']);
    const controller = new AbortController();
    const run = (await client(hang)).complete({ input: 'x', signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(run).rejects.toMatchObject({ code: 'CANCELLED', retryable: false });

    await expect((await client(hang, 100)).complete({ input: 'x' })).rejects.toMatchObject({ code: 'TIMEOUT' });

    const aborted = new AbortController();
    aborted.abort();
    await expect((await client(hang)).complete({ input: 'x', signal: aborted.signal })).rejects.toThrow();
  });

  it('reports a missing executable as SPAWN_FAILED', async () => {
    await expect((await client(join(directory, 'missing-claude'))).complete({ input: 'x' }))
      .rejects.toMatchObject({ code: 'SPAWN_FAILED' });
  });
});
