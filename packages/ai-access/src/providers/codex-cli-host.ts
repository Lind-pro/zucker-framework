import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import http from 'node:http';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const ENVIRONMENT_KEYS = [
  'PATH',
  'LANG',
  'LC_ALL',
  'TZ',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'CODEX_CA_CERTIFICATE',
];

interface HostInferenceRequest {
  prompt: string;
  model: string;
  reasoningEffort?: string;
  textVerbosity?: string;
  schema?: Record<string, unknown>;
}

export interface CodexCliHostOptions {
  socketPath: string;
  executable: string;
  codexHome: string;
  workRoot: string;
  timeoutMs?: number;
  /** Maximum concurrent Codex child processes; extra requests get 503. Defaults to 4. */
  maxConcurrent?: number;
  /** Only the documented environment allowlist and HOME reach the child. */
  environment?: NodeJS.ProcessEnv;
}

export interface CodexCliHostClientOptions {
  socketPath: string;
  args: readonly string[];
  prompt: string;
  onStdout: (data: string) => void;
  onStderr: (data: string) => void;
  signal?: AbortSignal;
}

function validateRequest(value: unknown): HostInferenceRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid inference request');
  const request = value as Record<string, unknown>;
  if (
    typeof request.prompt !== 'string' ||
    !request.prompt.trim() ||
    typeof request.model !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(request.model) ||
    (request.reasoningEffort !== undefined &&
      (typeof request.reasoningEffort !== 'string' ||
        !EFFORTS.includes(request.reasoningEffort))) ||
    (request.textVerbosity !== undefined &&
      (typeof request.textVerbosity !== 'string' ||
        !['low', 'medium', 'high'].includes(request.textVerbosity))) ||
    (request.schema !== undefined &&
      (!request.schema || typeof request.schema !== 'object' || Array.isArray(request.schema)))
  ) {
    throw new Error('Invalid inference request');
  }
  return request as unknown as HostInferenceRequest;
}

function buildArgs(request: HostInferenceRequest, workdir: string, schemaPath?: string): string[] {
  // The host owns executable, permissions and paths; callers cannot run arbitrary commands.
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
    '--config',
    'approval_policy="never"',
    '--config',
    'allow_login_shell=false',
    '--config',
    'shell_environment_policy.inherit="none"',
    '--config',
    'default_permissions="subscription_inference"',
    // Host mode reads only a freshly-created scratch directory containing its schema.
    '--config',
    'permissions.subscription_inference.filesystem={":minimal"="read",":workspace_roots"={"."="read"}}',
    '--config',
    'permissions.subscription_inference.network.enabled=false',
    '--config',
    'web_search="disabled"',
    '--config',
    'tools.web_search=false',
    '--model',
    request.model,
    '--cd',
    workdir,
  ];
  if (request.reasoningEffort && request.reasoningEffort !== 'none') {
    args.push('--config', `model_reasoning_effort="${request.reasoningEffort}"`);
  }
  if (request.textVerbosity) args.push('--config', `model_verbosity="${request.textVerbosity}"`);
  if (schemaPath) args.push('--output-schema', schemaPath);
  return [...args, '-'];
}

/** Start an explicitly configured Unix socket host for restricted Codex inference. */
export async function startCodexCliHost(options: CodexCliHostOptions): Promise<http.Server> {
  const {
    socketPath,
    executable,
    codexHome,
    workRoot,
    timeoutMs = 900_000,
    maxConcurrent = 4,
    environment: sourceEnvironment = {},
  } = options;
  await mkdir(workRoot, { recursive: true, mode: 0o700 });
  let active = 0;
  const server = http.createServer(async (request, response) => {
    let workdir: string | undefined;
    if (active >= maxConcurrent) {
      response.writeHead(503).end();
      return;
    }
    active += 1;
    try {
      if (request.method !== 'POST' || request.url !== '/exec') {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_REQUEST_BYTES) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(bytes);
      }
      const input = validateRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      workdir = await mkdtemp(join(workRoot, 'request-'));
      let schemaPath: string | undefined;
      if (input.schema) {
        schemaPath = join(workdir, 'schema.json');
        await writeFile(schemaPath, JSON.stringify(input.schema), { mode: 0o600 });
      }
      if (response.destroyed) return;
      const environment: NodeJS.ProcessEnv = {
        HOME: sourceEnvironment.HOME,
        CODEX_HOME: codexHome,
      };
      for (const key of ENVIRONMENT_KEYS) {
        if (sourceEnvironment[key] !== undefined) environment[key] = sourceEnvironment[key];
      }
      const child = spawn(executable, buildArgs(input, workdir, schemaPath), {
        cwd: workdir,
        env: environment,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
      let closed = false;
      let stopping = false;
      const terminate = () => {
        const pid = child.pid;
        if (closed || stopping || !pid) return;
        stopping = true;
        const killGroup = (signal: NodeJS.Signals) => {
          try {
            process.kill(-pid, signal);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal);
          }
        };
        killGroup('SIGTERM');
        const killTimer = setTimeout(() => killGroup('SIGKILL'), 5000);
        killTimer.unref();
      };
      const timer = setTimeout(terminate, timeoutMs);
      response.on('close', terminate);
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      const frame = (value: { stream: 'stdout' | 'stderr'; data: string } | { code: number }) => {
        if (!response.destroyed) response.write(`${JSON.stringify(value)}\n`);
      };
      for (const stream of ['stdout', 'stderr'] as const) {
        child[stream].setEncoding('utf8');
        child[stream].on('data', (data: string) => frame({ stream, data }));
      }
      child.stdin.on('error', terminate);
      child.on('error', () =>
        frame({ stream: 'stderr', data: 'Unable to start host Codex CLI.\n' }),
      );
      await new Promise<void>((resolve) => {
        child.once('close', (code) => {
          closed = true;
          clearTimeout(timer);
          response.off('close', terminate);
          frame({ code: stopping ? 1 : (code ?? 1) });
          response.end();
          resolve();
        });
        child.stdin.end(input.prompt);
      });
    } catch {
      if (!response.headersSent) response.writeHead(400);
      response.end();
    } finally {
      active -= 1;
      if (workdir) await rm(workdir, { recursive: true, force: true });
    }
  });
  server.requestTimeout = 30_000;
  await removeStaleSocket(socketPath);
  // Create the socket owner-only from the start instead of tightening it after bind.
  const previousUmask = trySetUmask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
  } finally {
    if (previousUmask !== undefined) trySetUmask(previousUmask);
  }
  await chmod(socketPath, 0o600);
  return server;
}

/** Forward the supported CLI arguments as data; never forward arbitrary executable/configuration arguments. */
export async function runCodexCliHostClient(options: CodexCliHostClientOptions): Promise<number> {
  const { args, socketPath, prompt, onStdout, onStderr, signal } = options;
  const input: HostInferenceRequest = { prompt, model: '' };
  let schemaPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--model') input.model = args[++index] ?? '';
    else if (args[index] === '--output-schema') schemaPath = args[++index];
    else if (args[index] === '--config') {
      const config = args[++index];
      const effort = config?.match(/^model_reasoning_effort="([a-z]+)"$/);
      const verbosity = config?.match(/^model_verbosity="([a-z]+)"$/);
      if (effort) input.reasoningEffort = effort[1];
      if (verbosity) input.textVerbosity = verbosity[1];
    }
  }
  if (schemaPath)
    input.schema = JSON.parse(await readFile(schemaPath, 'utf8')) as Record<string, unknown>;
  validateRequest(input);
  if (signal?.aborted) throw signal.reason;
  const request = http.request({ socketPath, path: '/exec', method: 'POST' });
  const cancel = () => request.destroy(new Error('Host Codex inference cancelled'));
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const responsePromise = new Promise<http.IncomingMessage>((resolve, reject) => {
      request.once('response', resolve);
      request.once('error', reject);
    });
    request.end(JSON.stringify(input));
    const response = await responsePromise;
    if (response.statusCode !== 200) {
      response.resume();
      throw new Error('Host rejected Codex inference request');
    }
    let exitCode: number | undefined;
    let streamFailure: Error | undefined;
    const lines = createInterface({ input: response });
    const failStream = (error: Error) => {
      streamFailure = error;
      lines.close();
    };
    const onAborted = () => failStream(new Error('Host Codex connection aborted'));
    response.once('aborted', onAborted);
    response.once('error', failStream);
    try {
      for await (const line of lines) {
        const frame = JSON.parse(line) as { stream?: string; data?: unknown; code?: unknown };
        if (frame.stream === 'stdout' && typeof frame.data === 'string') onStdout(frame.data);
        else if (frame.stream === 'stderr' && typeof frame.data === 'string') onStderr(frame.data);
        else if (typeof frame.code === 'number' && Number.isInteger(frame.code))
          exitCode = frame.code;
      }
    } finally {
      lines.close();
      response.off('aborted', onAborted);
      response.off('error', failStream);
    }
    if (streamFailure) throw streamFailure;
    if (exitCode === undefined) throw new Error('Host Codex connection ended before completion');
    return exitCode;
  } finally {
    signal?.removeEventListener('abort', cancel);
    request.destroy();
  }
}

function trySetUmask(mask: number): number | undefined {
  try {
    return process.umask(mask);
  } catch {
    return undefined; // Worker threads cannot change the umask; chmod below still applies.
  }
}

/** A socket file left by a crashed host makes listen fail with EADDRINUSE; remove it only when nothing answers. */
async function removeStaleSocket(socketPath: string): Promise<void> {
  const live = await new Promise<boolean | null>((resolve) => {
    const socket = net.connect(socketPath);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      resolve(error.code === 'ECONNREFUSED' ? false : null);
    });
  });
  if (live === false) await unlink(socketPath).catch(() => undefined);
}
