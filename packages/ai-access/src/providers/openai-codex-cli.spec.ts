// @vitest-environment node

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AIAccessRequest } from '../contracts';
import { codexInferenceConfigArgs } from './codex-inference-config';
import {
  CodexCliSubscriptionError,
  OpenAICodexCliSubscriptionProvider,
  createOpenAICodexCliAccessProvider,
  type CodexCliCommand,
} from './openai-codex-cli';

const request: AIAccessRequest = {
  model: 'gpt-5.6-luna',
  instructions: '只返回最终答案。',
  input: '分析这段技术方案。',
  reasoningEffort: 'high',
  textVerbosity: 'low',
  outputSchema: {
    type: 'object',
    properties: { summary: { type: 'string' } },
    required: ['summary'],
    additionalProperties: false,
  },
};

describe('OpenAICodexCliSubscriptionProvider', () => {
  it.each(['error', 'prompt-json'] as const)('按 %s 策略处理嵌套 oneOf，避免发送不受支持的 strict schema', async (unsupportedSchemaPolicy) => {
    const outputSchema = {
      type: 'object', properties: { actions: { type: 'array', items: { oneOf: [
        { type: 'object', properties: { type: { const: 'search' }, query: { type: 'string' } }, required: ['type', 'query'], additionalProperties: false },
        { type: 'object', properties: { type: { const: 'read' }, id: { type: 'string' } }, required: ['type', 'id'], additionalProperties: false },
      ] } } }, required: ['actions'], additionalProperties: false,
    };
    const commandRunner = vi.fn(async (_command: CodexCliCommand) => ({
      content: '{"actions":[{"type":"read","id":"synthetic-reference"}]}',
      finishReason: 'completed', tokenUsage: { input: 12, output: 4, total: 16 },
    }));
    const onSchemaFallback = vi.fn();
    const provider = new OpenAICodexCliSubscriptionProvider({
      executable: 'codex', codexHome: '/tmp/synthetic-codex-home', workingDirectory: '/tmp/codex-inference',
      unsupportedSchemaPolicy, onSchemaFallback, commandRunner,
    });
    const client = await provider.createModel({ modelId: request.model });
    const run = client.complete({ ...request, outputSchema });
    if (unsupportedSchemaPolicy === 'error') {
      await expect(run).rejects.toMatchObject({ code: 'NOT_CONFIGURED', message: expect.stringContaining('oneOf') });
      expect(commandRunner).not.toHaveBeenCalled();
    } else {
      await expect(run).resolves.toMatchObject({ finishReason: 'completed' });
      expect(onSchemaFallback).toHaveBeenCalledWith({ unsupportedKeywords: ['oneOf'] });
      expect(commandRunner).toHaveBeenCalledTimes(1);
      const command = commandRunner.mock.calls[0]![0];
      expect(command.args).not.toContain('--output-schema');
      expect(command.stdin).toContain(JSON.stringify(outputSchema));
      expect(command.stdin).toContain(request.input);
    }
  });

  it('以最小权限、临时会话和隔离环境运行官方 Codex CLI', async () => {
    let captured: CodexCliCommand | undefined;
    const commandRunner = vi.fn(async (command: CodexCliCommand) => {
      captured = command;
      const schemaPath = command.args[command.args.indexOf('--output-schema') + 1];
      const { readFile } = await import('node:fs/promises');
      expect(JSON.parse(await readFile(schemaPath, 'utf8'))).toEqual(request.outputSchema);
      return {
        content: '{"summary":"ok"}',
        finishReason: 'completed',
        responseId: 'thread-1',
        tokenUsage: { input: 12, output: 4, total: 16 },
      };
    });
    const provider = new OpenAICodexCliSubscriptionProvider({
      executable: '/opt/codex/bin/codex',
      codexHome: '/run/secrets/codex-home',
      workingDirectory: '/tmp/codex-inference',
      environment: {
        PATH: '/usr/bin:/bin',
        HTTPS_PROXY: 'https://proxy.example.test',
      },
      commandRunner,
    });
    const client = await provider.createModel({
      modelId: request.model,
      timeoutMs: 180_000,
    });

    await expect(client.complete(request)).resolves.toMatchObject({
      content: '{"summary":"ok"}',
      tokenUsage: { total: 16 },
    });

    expect(commandRunner).toHaveBeenCalledTimes(1);
    expect(captured).toBeDefined();
    expect(captured?.executable).toBe('/opt/codex/bin/codex');
    expect(captured?.cwd).toBe('/tmp/codex-inference');
    expect(captured?.env).toEqual({
      CODEX_HOME: '/run/secrets/codex-home',
      PATH: '/usr/bin:/bin',
      HTTPS_PROXY: 'https://proxy.example.test',
    });
    expect(captured?.args).toEqual(
      expect.arrayContaining([
        'exec',
        '--json',
        '--ephemeral',
        '--ignore-user-config',
        '--ignore-rules',
        '--strict-config',
        '--skip-git-repo-check',
        '--output-schema',
        '--model',
        'gpt-5.6-luna',
        '--cd',
        '/tmp/codex-inference',
        '-',
      ]),
    );
    expect(captured?.args).not.toContain('--sandbox');
    expect(captured?.args.join(' ')).toContain('default_permissions="subscription_inference"');
    expect(captured?.args.join(' ')).toContain('shell_environment_policy.inherit="none"');
    // Current Codex CLIs fail session creation when they cannot read AGENTS.md from a
    // denied workspace; the project-doc load must stay disabled with the workspace denied.
    expect(captured?.args.join(' ')).toContain(codexInferenceConfigArgs().join(' '));
    expect(captured?.args).toContain(
      'permissions.subscription_inference.filesystem={":minimal"="read",":workspace_roots"={"."="deny"}}',
    );
    expect(captured?.args).toContain('project_doc_max_bytes=0');
    expect(captured?.args).toContain('features.apps=false');
    expect(captured?.args.join(' ')).toContain(
      'permissions.subscription_inference.network.enabled=false',
    );
    expect(captured?.args.join(' ')).toContain('web_search="disabled"');
    expect(captured?.stdin).toBe('只返回最终答案。\n\n---\n\n分析这段技术方案。');
    expect(captured?.args.join(' ')).not.toContain('技术方案');
    expect(captured?.timeoutMs).toBe(180_000);
  });

  it('拒绝把 API Key 注入订阅执行环境', () => {
    expect(
      () =>
        new OpenAICodexCliSubscriptionProvider({
          executable: 'codex',
          codexHome: '/run/secrets/codex-home',
          workingDirectory: '/tmp/codex-inference',
          environment: { OPENAI_API_KEY: 'secret' },
        }),
    ).toThrow('OPENAI_API_KEY');
  });

  it('通过通用 Registry 暴露外部 Codex Home 引用而不复制 Token', async () => {
    const plugin = createOpenAICodexCliAccessProvider({
      codexHome: '/run/secrets/codex-home',
      workingDirectory: '/tmp/codex-inference',
      commandRunner: vi.fn(),
    });

    expect(plugin.id).toBe('openai-codex-cli');
    expect(plugin.authMethods).toEqual([]);
    await expect(plugin.credentialSources[0].discover({ profileName: 'sample-project' })).resolves.toEqual([
      expect.objectContaining({
        providerId: 'openai-codex-cli',
        profileName: 'sample-project',
        ownership: 'external-readonly',
        credential: {
          kind: 'external-reference',
          source: 'codex-home',
          reference: '/run/secrets/codex-home',
        },
      }),
    ]);
  });

  it('保留取消语义，不把用户取消伪装成 Provider 失败', async () => {
    const commandRunner = vi.fn(async () => {
      throw new CodexCliSubscriptionError('CANCELLED', 'Codex 订阅调用已取消。');
    });
    const provider = new OpenAICodexCliSubscriptionProvider({
      executable: 'codex',
      codexHome: '/run/secrets/codex-home',
      workingDirectory: '/tmp/codex-inference',
      commandRunner,
    });
    const client = await provider.createModel({ modelId: 'gpt-5.6-luna' });

    await expect(client.complete({ model: 'gpt-5.6-luna', input: 'test' })).rejects.toMatchObject({
      name: 'CodexCliSubscriptionError',
      code: 'CANCELLED',
      retryable: false,
    });
  });

  it('解析官方 JSONL 事件并只返回最后一条 agent message', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zucker-codex-cli-test-'));
    const executable = join(directory, 'fake-codex');
    await writeFile(
      executable,
      [
        '#!/usr/bin/env node',
        'process.stdin.resume();',
        "process.stdin.on('end', () => {",
        "  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-2' }) + '\\n');",
        "  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'first' } }) + '\\n');",
        "  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final' } }) + '\\n');",
        "  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 3 } }) + '\\n');",
        '});',
      ].join('\n'),
      { mode: 0o700 },
    );
    try {
      const provider = new OpenAICodexCliSubscriptionProvider({
        executable,
        codexHome: directory,
        workingDirectory: directory,
        environment: { PATH: process.env.PATH },
      });
      const client = await provider.createModel({ modelId: 'gpt-5.6-luna' });

      await expect(client.complete({ input: 'test' })).resolves.toEqual({
        content: 'final',
        finishReason: 'completed',
        responseId: 'thread-2',
        tokenUsage: { input: 7, output: 3, total: 10 },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { name: '重连后正常完成', events: [
      { type: 'error', message: 'Reconnecting... 2/5 (workspace routing discovery timed out)' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'final' } },
      { type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 3 } },
    ], errorCode: null },
    { name: '重连后最终失败', events: [
      { type: 'error', message: 'Reconnecting... 2/5 (workspace routing discovery timed out)' },
      { type: 'turn.failed', error: { message: 'upstream unavailable' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'must not pass' } },
      { type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 3 } },
    ], errorCode: 'EXECUTION_FAILED' },
    { name: '只有重连提示和未完成消息', events: [
      { type: 'error', message: 'Reconnecting... 2/5 (workspace routing discovery timed out)' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'partial' } },
    ], errorCode: 'EXECUTION_FAILED' },
    { name: '推理与配置提示不算工具调用', events: [
      { type: 'item.completed', item: { type: 'error', message: 'Codex is ignoring 1 unrecognized configuration setting.' } },
      { type: 'item.started', item: { type: 'reasoning' } },
      { type: 'item.completed', item: { type: 'reasoning', text: 'thinking' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'final' } },
      { type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 3 } },
    ], errorCode: null },
    ...['collab_tool_call', 'mcp_tool_call', 'command_execution', 'file_change', 'web_search', 'todo_list'].map(itemType => ({
      name: `工具调用 ${itemType} 立即终止`, events: [
        { type: 'item.started', item: { type: itemType } },
        { type: 'item.completed', item: { type: 'agent_message', text: 'final' } },
        { type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 3 } },
      ], errorCode: 'EXECUTION_FAILED',
    })),
    { name: '没有完成用量', events: [
      { type: 'item.completed', item: { type: 'agent_message', text: 'partial' } },
    ], errorCode: 'INVALID_OUTPUT' },
    ...[{}, { input_tokens: 7 }, { input_tokens: 7, output_tokens: -1 }, { input_tokens: 7.5, output_tokens: 3 }, { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 3 }].map(usage => ({
      name: `无效用量 ${JSON.stringify(usage)}`, events: [
        { type: 'item.completed', item: { type: 'agent_message', text: 'final' } },
        { type: 'turn.completed', usage },
      ], errorCode: 'INVALID_OUTPUT',
    })),
  ])('严格依据最终事件结算：$name', async ({ events, errorCode }) => {
    const directory = await mkdtemp(join(tmpdir(), 'zucker-codex-cli-test-'));
    const executable = join(directory, 'fake-codex');
    await writeFile(executable, [
      '#!/usr/bin/env node',
      'process.stdin.resume();',
      `const events = ${JSON.stringify(events)};`,
      "process.stdin.on('end', () => events.forEach(event => process.stdout.write(JSON.stringify(event) + '\\n')));",
    ].join('\n'), { mode: 0o700 });
    try {
      const provider = new OpenAICodexCliSubscriptionProvider({ executable, codexHome: directory, workingDirectory: directory, environment: { PATH: process.env.PATH } });
      const client = await provider.createModel({ modelId: 'gpt-5.6-luna' });
      if (errorCode) await expect(client.complete({ input: 'test' })).rejects.toMatchObject({ code: errorCode });
      else await expect(client.complete({ input: 'test' })).resolves.toMatchObject({ content: 'final', finishReason: 'completed', tokenUsage: { input: 7, output: 3, total: 10 } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
