import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCodexCliHostClient, runCodexCliHostImage, startCodexCliHost } from './codex-cli-host';
import { codexInferenceConfigArgs } from './codex-inference-config';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'framework-codex-host-')));
  const executable = join(root, 'fake-codex.mjs');
  const socketPath = join(root, 'host.sock');
  const workRoot = join(root, 'work');
  const codexHome = join(root, 'home');
  await mkdir(codexHome);
  await writeFile(
    executable,
    `#!${process.execPath}
import { readFileSync, statSync } from 'node:fs';
if (process.argv.includes('app-server')) {
 const send = event => process.stdout.write(JSON.stringify(event) + '\\n');
 const {createInterface} = await import('node:readline');
 createInterface({input:process.stdin}).on('line', line => {
  const r=JSON.parse(line);
  if(r.method==='initialize') send({id:r.id,result:{}});
  if(r.method==='config/read') send({id:r.id,result:{config:{}}});
  if(r.method==='thread/start') send({id:r.id,result:{thread:{id:'thread'}}});
  if(r.method==='turn/start') {
   send({id:r.id,result:{turn:{id:'turn'}}});
   if(JSON.stringify(r.params).includes('wait')) return;
   const note=(method,extra)=>send({method,params:{threadId:'thread',turnId:'turn',...extra}});
   note('item/completed',{item:{type:'imageGeneration',id:'image',status:'completed',result:JSON.stringify(r.params).includes('invalid')?'invalid':'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='}});
   note('thread/tokenUsage/updated',{tokenUsage:{total:{inputTokens:7,outputTokens:3}}});
   note('turn/completed',{turn:{id:'turn',status:'completed'}});
  }
 });
} else {
let prompt = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) prompt += chunk;
if (prompt === 'wait') {
  process.stdout.write('started\\n');
  setInterval(() => {}, 1000);
} else {
  const args = process.argv.slice(2);
  const position = args.indexOf('--output-schema');
  const schemaPath = position >= 0 ? args[position + 1] : null;
  process.stdout.write(JSON.stringify({ prompt, args, cwd: process.cwd(), home: process.env.CODEX_HOME,
    injected: process.env.UNSAFE_PRODUCT_SECRET,
    schema: schemaPath ? JSON.parse(readFileSync(schemaPath, 'utf8')) : null,
    schemaMode: schemaPath ? statSync(schemaPath).mode & 0o777 : null }) + '\\n');
  process.stderr.write('diagnostic 日本語\\n');
  process.exitCode = 7;
}
}
`,
    { mode: 0o700 },
  );
  const server = await startCodexCliHost({
    socketPath,
    executable,
    codexHome,
    workRoot,
    timeoutMs: 30_000,
    environment: { HOME: root, PATH: process.env.PATH, UNSAFE_PRODUCT_SECRET: 'must-not-cross' },
  });
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  return { root, socketPath, workRoot, codexHome };
}

describe('Codex Unix socket host/client contract', () => {
  it('transfers only allowed model settings, exact prompt and schema to the restricted host', async () => {
    const f = await fixture();
    const schema = {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
    };
    const schemaPath = join(f.root, 'input-schema.json');
    await writeFile(schemaPath, JSON.stringify(schema));
    let stdout = '';
    let stderr = '';
    const prompt = '  日本語\nexact input\n';
    const code = await runCodexCliHostClient({
      socketPath: f.socketPath,
      prompt,
      args: [
        '--model',
        'synthetic-model',
        '--output-schema',
        schemaPath,
        '--config',
        'model_reasoning_effort="high"',
        '--config',
        'approval_policy="always"',
      ],
      onStdout: (chunk) => {
        stdout += chunk;
      },
      onStderr: (chunk) => {
        stderr += chunk;
      },
    });
    const output = JSON.parse(stdout);
    expect(code).toBe(7);
    expect(stderr).toBe('diagnostic 日本語\n');
    expect(output.prompt).toBe(prompt);
    expect(output.schema).toEqual(schema);
    expect(output.schemaMode).toBe(0o600);
    expect(output.home).toBe(f.codexHome);
    expect(output.injected).toBeUndefined();
    expect(output.cwd.startsWith(f.workRoot + '/')).toBe(true);
    expect(output.args).toContain('approval_policy="never"');
    expect(output.args).toContain('permissions.subscription_inference.network.enabled=false');
    expect(output.args.join(' ')).toContain(codexInferenceConfigArgs().join(' '));
    expect(output.args).toContain(
      'permissions.subscription_inference.filesystem={":minimal"="read",":workspace_roots"={"."="deny"}}',
    );
    expect(output.args).toContain('project_doc_max_bytes=0');
    expect(output.args).toContain('model_reasoning_effort="high"');
    expect(output.args).not.toContain('approval_policy="always"');
    await expect.poll(async () => readdir(f.workRoot)).toEqual([]);
    expect(JSON.parse(await readFile(schemaPath, 'utf8'))).toEqual(schema);
  });

  it('rejects command-shaped model names before starting the host process', async () => {
    const f = await fixture();
    await expect(
      runCodexCliHostClient({
        socketPath: f.socketPath,
        args: ['--model', 'model; unexpected'],
        prompt: 'test',
        onStdout: () => undefined,
        onStderr: () => undefined,
      }),
    ).rejects.toThrow('Invalid inference request');
    expect(await readdir(f.workRoot)).toEqual([]);
  });

  it('settles the client on cancellation and removes the request scratch directory', async () => {
    const f = await fixture();
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = runCodexCliHostClient({
      socketPath: f.socketPath,
      args: ['--model', 'synthetic-model'],
      prompt: 'wait',
      signal: controller.signal,
      onStdout: () => started(),
      onStderr: () => undefined,
    });
    const failure = expect(pending).rejects.toThrow();
    await ready;
    controller.abort();
    await failure;
    await expect.poll(async () => readdir(f.workRoot)).toEqual([]);
  });
});


it('returns native image bytes and usage through the host and removes scratch files', async () => {
  const f = await fixture();
  const result = await runCodexCliHostImage(f.socketPath, { model: 'synthetic-model', input: 'draw' });
  expect(result).toMatchObject({ finishReason: 'completed', tokenUsage: { input: 7, output: 3, total: 10 }, images: [{ mimeType: 'image/png' }] });
  expect(Buffer.from(result.images![0].data, 'base64').subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  await expect.poll(async () => readdir(f.workRoot)).toEqual([]);
});

it('rejects failed native images without retrying a text or API route', async () => {
  const f = await fixture();
  await expect(runCodexCliHostImage(f.socketPath, { model: 'synthetic-model', input: 'invalid' })).rejects.toThrow();
  await expect.poll(async () => readdir(f.workRoot)).toEqual([]);
});

it('cancels native image inference and cleans the per-call directory', async () => {
  const f = await fixture(), controller = new AbortController();
  const request = runCodexCliHostImage(f.socketPath, { model: 'synthetic-model', input: 'wait', signal: controller.signal });
  const failure = expect(request).rejects.toThrow();
  await expect.poll(async () => (await readdir(f.workRoot)).length).toBe(1);
  controller.abort();
  await failure;
  await expect.poll(async () => readdir(f.workRoot)).toEqual([]);
});
