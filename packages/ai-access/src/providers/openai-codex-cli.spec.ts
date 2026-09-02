// @vitest-environment node

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AIAccessRequest } from '../contracts';
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
    expect(captured?.args.join(' ')).toContain('permissions.subscription_inference.filesystem');
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
    await expect(plugin.credentialSources[0].discover({ profileName: 'cnipa' })).resolves.toEqual([
      expect.objectContaining({
        providerId: 'openai-codex-cli',
        profileName: 'cnipa',
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
});
