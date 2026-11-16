// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexInferenceConfigArgs } from './codex-inference-config';
import { OpenAICodexCliSubscriptionProvider } from './openai-codex-cli';

async function fixture(
  events: unknown[],
  work: (
    client: Awaited<ReturnType<OpenAICodexCliSubscriptionProvider['createModel']>>,
    directory: string,
  ) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'zucker-codex-app-server-test-'));
  const executable = join(directory, 'fake-codex');
  await writeFile(
    executable,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs'); const readline = require('node:readline');",
      `const events = ${JSON.stringify(events)};`,
      `const log = ${JSON.stringify(join(directory, 'requests.jsonl'))};`,
      `fs.writeFileSync(${JSON.stringify(join(directory, 'argv.json'))}, JSON.stringify(process.argv.slice(2)));`,
      "const send = event => process.stdout.write(JSON.stringify(event) + '\\n');",
      "readline.createInterface({input: process.stdin}).on('line', line => {",
      "const request = JSON.parse(line); fs.appendFileSync(log, line + '\\n');",
      "if(request.method === 'initialize') send({id:request.id,result:{}});",
      "if(request.method === 'config/read') send({id:request.id,result:{config:{mcp_servers:{private_tool:{enabled:true}},apps:{external_app:{enabled:true}},plugins:{external_plugin:{enabled:true}}}}});",
      "if(request.method === 'thread/start') send({id:request.id,result:{thread:{id:'thread'}}});",
      "if(request.method === 'turn/start') { send({id:request.id,result:{turn:{id:'turn'}}}); let i=0; const next=()=>{ if(i<events.length) {send(events[i++]);setTimeout(next,10);} }; next(); }",
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
      timeoutMs: 1000,
    });
    await work(await provider.createModel({ modelId: 'configured-model' }), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
const notify = (method: string, extra: object) => ({
  method,
  params: { threadId: 'thread', turnId: 'turn', ...extra },
});
const successful = [
  notify('item/started', { item: { type: 'agentMessage', id: 'answer', phase: 'final_answer' } }),
  notify('item/reasoning/textDelta', { delta: 'hidden reasoning' }),
  notify('item/agentMessage/delta', { itemId: 'answer', delta: 'first' }),
  notify('item/agentMessage/delta', { itemId: 'answer', delta: ' second' }),
  notify('item/completed', {
    item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: 'first second' },
  }),
  notify('thread/tokenUsage/updated', {
    tokenUsage: { total: { inputTokens: 7, outputTokens: 3 } },
  }),
  notify('turn/completed', { turn: { id: 'turn', status: 'completed' } }),
];

describe('Codex app-server streamed inference', () => {
  it('reports only a safe configuration field when the executable rejects startup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zucker-codex-startup-test-'));
    const executable = join(directory, 'fake-codex');
    await writeFile(
      executable,
      '#!/usr/bin/env node\nprocess.stderr.write("Error: unknown configuration field `tools.unsupported` in override\\nprivate-token-secret\\n");process.exit(1);',
      { mode: 0o700 },
    );
    try {
      const provider = new OpenAICodexCliSubscriptionProvider({
        executable,
        codexHome: directory,
        workingDirectory: directory,
        environment: { PATH: process.env.PATH },
      });
      const client = await provider.createModel({ modelId: 'configured-model' });
      await expect(
        client.complete({ input: 'synthetic', onTextDelta: () => undefined }),
      ).rejects.toMatchObject({
        code: 'NOT_CONFIGURED',
        message: 'Codex app server does not support configuration field tools.unsupported.',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('emits ordered real answer deltas before completion and disables configured external capabilities', async () => {
    await fixture(successful, async (client, directory) => {
      const order: string[] = [];
      const result = await client.complete({
        input: 'synthetic',
        instructions: 'answer only',
        onTextDelta: async (delta) => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          order.push(delta);
        },
      });
      expect(order).toEqual(['first', ' second']);
      expect(result).toMatchObject({ content: 'first second', tokenUsage: { total: 10 } });
      const messages = (await readFile(join(directory, 'requests.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const argv: string[] = JSON.parse(await readFile(join(directory, 'argv.json'), 'utf8'));
      expect(argv.slice(0, 3)).toEqual(['app-server', '--stdio', '--strict-config']);
      expect(argv.join(' ')).toContain(codexInferenceConfigArgs().join(' '));
      expect(argv).toContain('project_doc_max_bytes=0');
      const start = messages.find((message) => message.method === 'thread/start');
      expect(start.params).toMatchObject({
        ephemeral: true,
        approvalPolicy: 'never',
        permissions: 'subscription_inference',
        environments: [],
        dynamicTools: [],
        selectedCapabilityRoots: [],
        config: {
          'mcp_servers.private_tool.enabled': false,
          'apps.external_app.enabled': false,
          'plugins.external_plugin.enabled': false,
          'features.hooks': false,
        },
      });
    });
  });
  it('fails the call when a delta consumer fails, without consuming later paragraphs', async () => {
    await fixture(successful, async (client) => {
      const error = new Error('cannot persist');
      const deltas: string[] = [];
      await expect(
        client.complete({
          input: 'synthetic',
          onTextDelta: (delta) => {
            deltas.push(delta);
            throw error;
          },
        }),
      ).rejects.toBe(error);
      expect(deltas).toEqual(['first']);
    });
  });
  it('cancels an active inference and preserves its explicit cancellation outcome', async () => {
    await fixture(successful, async (client) => {
      const controller = new AbortController();
      await expect(
        client.complete({
          input: 'synthetic',
          signal: controller.signal,
          onTextDelta: () => controller.abort(),
        }),
      ).rejects.toMatchObject({ code: 'CANCELLED' });
    });
  });
  it.each([
    [
      'missing token usage',
      successful.filter((event) => event.method !== 'thread/tokenUsage/updated'),
    ],
    [
      'failed final turn',
      [
        ...successful.slice(0, -1),
        notify('turn/completed', { turn: { id: 'turn', status: 'failed' } }),
      ],
    ],
    [
      'completed output without real deltas',
      successful.filter((event) => event.method !== 'item/agentMessage/delta'),
    ],
    [
      'tool activity',
      [notify('item/started', { item: { type: 'commandExecution', id: 'command' } })],
    ],
  ])('does not accept %s as a successful stream', async (_name, events) => {
    await fixture(events, async (client) => {
      await expect(
        client.complete({ input: 'synthetic', onTextDelta: () => undefined }),
      ).rejects.toBeInstanceOf(Error);
    });
  });
});
