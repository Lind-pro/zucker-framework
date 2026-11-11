#!/usr/bin/env node
/**
 * Launch acceptance (PLAN §2 "ready to launch") on a project generated from PACKED tarballs.
 *
 *   node scripts/acceptance/launch-ready.mjs [--work <dir>] [--tier host|compose|all] [--phases a,b,...]
 *        [--registry-mode offline|proxy] [--keep] [--skip-build]
 *
 * Phases (default: all, in this order):
 *   pack      build:packages + pnpm pack of every public package (scripts/acceptance/pack.mjs)
 *   create    local file registry (127.0.0.1) + `pnpm dlx @zucker-framework/cli@<v> create my-saas`
 *   install   framework metadata from the registry (`pnpm store add`), `pnpm install --offline`;
 *             fallback recorded in the report: `--prefer-offline` (third-party packages from the network)
 *   host      throwaway PostgreSQL container, db:migrate, setup:admin, content:check, build (all apps)
 *   compose   images built from the workspace (framework packages through the registry in proxy mode),
 *             `docker compose up` on free ports with a unique project name; pass 1 production checks,
 *             pass 2 (server only, NODE_ENV=test + fake payment/AI providers) paid and AI checks
 *   teardown  `compose down -v --rmi local` for this project only, throwaway containers removed
 *
 * Host safety: unique names (zf-accept-<id>), free ports that never include the ports of other services
 * on this host, processes stopped by exact PID, never by pattern. Secrets from the generated .env are
 * never printed. Docker must be callable as `docker` (run the script under `sg docker -c` if needed).
 * Writes <work>/report.json (one entry per step: id, title, status, evidence) and <work>/logs/*.
 */
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, lstatSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pack } from './pack.mjs';
import { runChecks } from './checks.mjs';
import { auditAgentInstructions } from '../../packages/cli/tooling/agent-instructions.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** Ports of other services on shared hosts; never chosen, even when free at the moment. */
export const RESERVED_PORTS = new Set([3000, 4103, 4104, 4200, 4201, 4202, 4281, 5432, 6379, 8025, 1025, 9000, 9001]);
const PHASES = ['pack', 'create', 'install', 'host', 'compose', 'teardown'];

function parseArgs(argv) {
  const value = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
  const id = value('--id', Date.now().toString(36));
  return {
    id,
    work: resolve(value('--work', join(tmpdir(), `zf-accept-${id}`))),
    tier: value('--tier', 'all'),
    phases: (value('--phases', PHASES.join(','))).split(',').filter(Boolean),
    registryMode: value('--registry-mode', 'offline'),
    keep: argv.includes('--keep'),
    skipBuild: argv.includes('--skip-build'),
    project: value('--project-name', 'my-saas'),
  };
}

/** A free TCP port on 127.0.0.1 outside RESERVED_PORTS and outside `taken`. */
export async function freePort(taken = new Set()) {
  for (;;) {
    const port = await new Promise((done, fail) => {
      const server = createServer();
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => { const { port: chosen } = server.address(); server.close(() => done(chosen)); });
    });
    if (!RESERVED_PORTS.has(port) && !taken.has(port) && port > 1024) { taken.add(port); return port; }
  }
}

/** Replaces or appends `KEY=value` lines; never prints values. */
export function rewriteEnv(text, values) {
  const seen = new Set();
  const lines = text.split('\n').map((line) => {
    const key = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1];
    if (!key || !Object.hasOwn(values, key)) return line;
    seen.add(key);
    return `${key}=${values[key]}`;
  });
  const missing = Object.keys(values).filter((key) => !seen.has(key));
  return `${lines.join('\n').replace(/\n*$/, '\n')}${missing.length ? `${missing.map((key) => `${key}=${values[key]}`).join('\n')}\n` : ''}`;
}

export function readEnv(path) {
  const values = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

class Report {
  constructor(path) { this.path = path; this.steps = []; this.meta = {}; }
  add(entry) {
    const existing = this.steps.findIndex((step) => step.id === entry.id);
    if (existing >= 0) this.steps[existing] = entry; else this.steps.push(entry);
    process.stdout.write(`${entry.status.toUpperCase().padEnd(4)} ${entry.id} ${entry.title}${entry.status === 'pass' ? '' : ` — ${entry.evidence?.error ?? entry.evidence?.reason ?? ''}`}\n`);
    this.save();
  }
  async step(id, title, fn) {
    const started = Date.now();
    try {
      const evidence = await fn();
      this.add({ id, title, status: evidence?.skipped ? 'skip' : 'pass', ms: Date.now() - started, evidence: evidence ?? {} });
      return evidence;
    } catch (error) {
      this.add({ id, title, status: 'fail', ms: Date.now() - started, evidence: { error: String(error?.message ?? error).slice(0, 2000) } });
      return undefined;
    }
  }
  save() { writeFileSync(this.path, `${JSON.stringify({ ...this.meta, steps: this.steps }, null, 2)}\n`); }
  failed() { return this.steps.filter((step) => step.status === 'fail'); }
}

function makeRunner(logs) {
  /** Runs a command; output goes to logs/<name>.log only (it can contain generated configuration). */
  return function run(name, command, args, options = {}) {
    const log = join(logs, `${name}.log`);
    appendFileSync(log, `$ ${command} ${args.join(' ')}\n`);
    try {
      const output = execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, ...options });
      appendFileSync(log, output);
      return output;
    } catch (error) {
      appendFileSync(log, `${error.stdout ?? ''}${error.stderr ?? ''}\nexit ${error.status}\n`);
      const tail = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim().split('\n').slice(-12).join('\n');
      throw new Error(`${command} ${args.slice(0, 4).join(' ')} failed (exit ${error.status}); see logs/${name}.log\n${tail}`);
    }
  };
}

/** Starts a long-lived child (tracked by PID); stdout/stderr to a log. */
function startChild(logs, name, command, args, options = {}) {
  const out = join(logs, `${name}.log`);
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => appendFileSync(out, chunk));
  child.stderr.on('data', (chunk) => appendFileSync(out, chunk));
  return child;
}

async function waitFor(label, probe, timeoutMs = 120_000, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { const value = await probe(); if (value) return value; } catch (error) { last = error; }
    await new Promise((done) => setTimeout(done, intervalMs));
  }
  throw new Error(`${label} not ready after ${timeoutMs} ms${last ? ` (${last.message ?? last})` : ''}`);
}

function walk(directory, visit, depth = 0) {
  if (depth > 6) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', '.next'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, visit, depth + 1); else visit(path);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const { work, id } = options;
  const logs = join(work, 'logs');
  mkdirSync(logs, { recursive: true });
  const report = new Report(join(work, 'report.json'));
  if (existsSync(report.path)) {
    const previous = JSON.parse(readFileSync(report.path, 'utf8'));
    report.steps = previous.steps ?? [];
    report.meta = { ...previous, steps: undefined };
  }
  report.meta = { ...report.meta, id, startedAt: report.meta.startedAt ?? new Date().toISOString(), tier: options.tier, registryMode: options.registryMode };
  const run = makeRunner(logs);
  const projects = join(work, 'projects');
  const project = join(projects, options.project);
  const packDir = join(work, 'pack');
  const statePath = join(work, 'state.json');
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  const saveState = () => writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const children = [];
  const cleanups = [];
  const want = (phase) => options.phases.includes(phase);
  const tierHost = options.tier === 'host' || options.tier === 'all';
  const tierCompose = options.tier === 'compose' || options.tier === 'all';

  let registry;
  /**
   * The registry runs as a child process (tracked by PID): the phases call blocking commands, which
   * would starve an in-process server. `requests` reads its JSONL request log.
   */
  const ensureRegistry = async (mode) => {
    if (registry && registry.mode === mode) return registry;
    if (registry) await registry.close();
    const port = state.registryPort ?? await freePort();
    state.registryPort = port; saveState();
    const log = join(logs, 'registry-requests.jsonl');
    const child = startChild(logs, `registry-${mode}`, process.execPath, [join(rootDir, 'scripts/acceptance/file-registry.mjs'),
      '--manifest', join(packDir, 'manifest.json'), '--port', String(port), '--log', log, ...(mode === 'proxy' ? ['--upstream', 'https://registry.npmjs.org/'] : [])]);
    children.push(child);
    const url = `http://127.0.0.1:${port}/`;
    await waitFor('local registry', async () => (await fetch(`${url}@zucker-framework%2fcli`)).ok, 15_000, 200);
    const offset = existsSync(log) ? readFileSync(log, 'utf8').length : 0;
    registry = {
      url, mode, port,
      get requests() { return existsSync(log) ? readFileSync(log, 'utf8').slice(offset).split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []; },
      close: () => new Promise((done) => { if (child.exitCode !== null) { done(); return; } child.once('exit', () => done()); child.kill('SIGTERM'); }),
    };
    return registry;
  };
  const npmrc = () => {
    const path = join(work, 'npmrc');
    writeFileSync(path, `@zucker-framework:registry=${registry.url}\n`);
    return path;
  };
  const manifest = () => JSON.parse(readFileSync(join(packDir, 'manifest.json'), 'utf8'));

  try {
    // ── pack ───────────────────────────────────────────────────────────────────────────────
    if (want('pack')) {
      await report.step('pack', 'Build and pack every public package', () => {
        // build:packages rebuilds the CLI whenever templates/** or docs/templates/** change (packages/cli/turbo.json).
        const packed = pack({ out: packDir, skipBuild: options.skipBuild, log: (line) => appendFileSync(join(logs, 'pack.log'), `${line}\n`) });
        return { packages: packed.packages.length, release: packed.release, sourceDirty: packed.sourceDirty };
      });
    }

    // ── create (PLAN §2 step 1) ───────────────────────────────────────────────────────────────
    const cliVersion = () => manifest().packages.find((entry) => entry.name === '@zucker-framework/cli').version;
    if (want('create')) {
      await ensureRegistry('offline');
      mkdirSync(projects, { recursive: true });
      await report.step('create', `pnpm dlx @zucker-framework/cli create ${options.project} (packed CLI, offline)`, () => {
        if (existsSync(project)) throw new Error(`${project} already exists; use a new --work directory`);
        run('create', 'pnpm', ['dlx', `@zucker-framework/cli@${cliVersion()}`, 'create', options.project], {
          cwd: projects, env: { ...process.env, NPM_CONFIG_USERCONFIG: npmrc(), npm_config_offline: 'true' },
        });
        return { cli: cliVersion(), directory: project };
      });
      await report.step('1', 'Workspace layout, one root .env (0600, distinct secrets), AGENTS.md, skills, no local references', () => {
        for (const path of ['apps/server/package.json', 'apps/web/package.json', 'apps/admin/package.json', 'docker-compose.yml', '.env', 'AGENTS.md', 'pnpm-workspace.yaml'])
          if (!existsSync(join(project, path))) throw new Error(`missing ${path}`);
        const mode = statSync(join(project, '.env')).mode & 0o777;
        if (mode !== 0o600) throw new Error(`.env mode is ${mode.toString(8)}`);
        const env = readEnv(join(project, '.env'));
        const secretKeys = ['JWT_SECRET', 'CONFIG_ENCRYPTION_KEY', 'REVALIDATE_SECRET', 'POSTGRES_PASSWORD', 'REDIS_PASSWORD', 'MINIO_ROOT_PASSWORD', 'FILES_S3_SECRET_ACCESS_KEY'];
        const secrets = secretKeys.map((key) => env[key] ?? '');
        if (secrets.some((value) => value.length < 32)) throw new Error('a generated secret is missing or short');
        if (new Set(secrets).size !== secrets.length) throw new Error('generated secrets are not distinct');
        const skills = readdirSync(join(project, '.agents/skills')).sort();
        for (const name of ['brand-quickstart', 'page-builder']) if (!skills.includes(name)) throw new Error(`skill ${name} missing`);
        for (const name of skills) if (!lstatSync(join(project, '.claude/skills', name)).isSymbolicLink()) throw new Error(`.claude/skills/${name} is not a link`);
        const manifests = [];
        walk(project, (path) => { if (path.endsWith('package.json')) manifests.push(path); });
        for (const path of manifests) {
          const text = readFileSync(path, 'utf8');
          if (/"(?:workspace|file|link):/.test(text)) throw new Error(`${path} has a local package reference`);
        }
        const audit = auditAgentInstructions(project, { skillsDirectory: '.agents/skills', documents: ['AGENTS.md'], rootDocument: 'AGENTS.md',
          compatibilityLinks: [{ path: 'CLAUDE.md', target: 'AGENTS.md' }], skillAliasDirectories: ['.claude/skills'], allowSkillReferenceAliases: true, checkGit: false });
        if (audit.errors.length) throw new Error(`instruction audit: ${audit.errors.slice(0, 5).join('; ')}`);
        return { apps: readdirSync(join(project, 'apps')).sort(), envMode: '0600', distinctSecrets: secrets.length, skills, manifests: manifests.length, audit: { skills: audit.skills, aliases: audit.aliases } };
      });
    }

    // ── install ───────────────────────────────────────────────────────────────────────────────
    if (want('install')) {
      await ensureRegistry('offline');
      writeFileSync(join(project, '.npmrc'), `@zucker-framework:registry=${registry.url}\n`);
      await report.step('install', 'pnpm install from packed tarballs (offline first)', () => {
        const names = manifest().packages.map((entry) => `${entry.name}@${entry.version}`);
        run('store-add', 'pnpm', ['store', 'add', ...names], { cwd: project, env: { ...process.env, NPM_CONFIG_USERCONFIG: npmrc() } });
        let method = 'offline';
        try {
          run('install-offline', 'pnpm', ['install', '--offline'], { cwd: project });
        } catch (error) {
          const offlineLog = existsSync(join(logs, 'install-offline.log')) ? readFileSync(join(logs, 'install-offline.log'), 'utf8') : '';
          const missing = /Failed to resolve (\S+)/.exec(offlineLog)?.[1] ?? /Failed to resolve (\S+)/.exec(String(error.message))?.[1];
          method = `prefer-offline (offline lacked third-party metadata${missing ? `: ${missing}` : ''}; third-party packages from the network, framework packages only from the local registry)`;
          run('install-prefer-offline', 'pnpm', ['install', '--prefer-offline'], { cwd: project });
        }
        // The lockfile must hold exactly the packed tarballs' integrity for every framework package.
        const lock = readFileSync(join(project, 'pnpm-lock.yaml'), 'utf8');
        let matched = 0;
        for (const entry of manifest().packages) {
          const at = lock.indexOf(`\n  '${entry.name}@${entry.version}':\n`) >= 0 ? lock.indexOf(`\n  '${entry.name}@${entry.version}':\n`) : lock.indexOf(`\n  ${entry.name}@${entry.version}:\n`);
          if (at < 0) continue;
          const integrity = /integrity: ([^,}\s]+)/.exec(lock.slice(at, at + 400))?.[1];
          if (integrity !== entry.integrity) throw new Error(`${entry.name} resolved to another artefact than the packed tarball`);
          matched++;
        }
        const requests = registry.requests;
        const outside = requests.filter((request) => request.outcome !== 'served').map((request) => request.name ?? request.path);
        if (/127\.0\.0\.1/.test(lock)) throw new Error('lockfile records the local registry URL');
        return { method, frameworkPackagesInLockfile: matched, registryRequests: requests.length, registryNotServed: [...new Set(outside)] };
      });
    }

    // ── host tier (PLAN §2 step 2 on the host) ─────────────────────────────────────────────────
    if (want('host') && tierHost) {
      const pgName = `zf-accept-${id}-pg`;
      const pgPort = await freePort();
      const password = `pg${id}${Math.random().toString(36).slice(2)}`;
      await report.step('host.postgres', 'Throwaway PostgreSQL for the host tier', async () => {
        run('host-pg', 'docker', ['run', '-d', '--rm', '--name', pgName, '-e', 'POSTGRES_USER=app', '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=host_accept',
          '-p', `127.0.0.1:${pgPort}:5432`, 'postgres:17-alpine']);
        cleanups.push(() => run('host-pg-stop', 'docker', ['rm', '-f', pgName]));
        await waitFor('postgres', () => { run('host-pg-ready', 'docker', ['exec', pgName, 'pg_isready', '-U', 'app', '-d', 'host_accept']); return true; }, 60_000);
        await new Promise((done) => setTimeout(done, 1500));
        return { container: pgName, port: pgPort };
      });
      const hostEnv = { ...process.env, DATABASE_URL: `postgresql://app:${password}@127.0.0.1:${pgPort}/host_accept` };
      await report.step('host.migrate', 'pnpm db:migrate', () => {
        const output = run('host-migrate', 'pnpm', ['db:migrate'], { cwd: project, env: hostEnv });
        return { applied: (output.match(/migrations\/\n/g) ?? []).length || undefined, result: /All migrations have been successfully applied|No pending migrations/.exec(output)?.[0] };
      });
      await report.step('host.setup-admin', 'pnpm setup:admin (administrator, starter content, example plans and pack)', () => {
        run('host-setup-admin', 'pnpm', ['setup:admin'], { cwd: project, env: { ...hostEnv,
          BOOTSTRAP_ADMIN_USERNAME: 'acceptadmin', BOOTSTRAP_ADMIN_EMAIL: 'admin@accept.invalid', BOOTSTRAP_ADMIN_PASSWORD: 'Synthetic-Accept-9!x' } });
        const query = (sql) => run('host-psql', 'docker', ['exec', pgName, 'psql', '-U', 'app', '-d', 'host_accept', '-tAc', sql]).trim();
        const counts = {
          administrators: Number(query("select count(*) from users where username = 'acceptadmin'")),
          plans: query('select string_agg(slug, \',\' order by slug) from subscription_plans'),
          packs: query('select string_agg(slug, \',\' order by slug) from credit_packs'),
          content: query("select string_agg(distinct kind || ':' || slug, ',') from site_content_entries where locale = 'en'"),
        };
        if (counts.administrators !== 1) throw new Error('administrator not created');
        if ((counts.plans ?? '').split(',').filter(Boolean).length < 2 || !(counts.packs ?? '')) throw new Error(`plans/packs not seeded: ${JSON.stringify(counts)}`);
        for (const slug of ['home', 'privacy', 'terms']) if (!counts.content.includes(`page:${slug}`)) throw new Error(`content page ${slug} not seeded`);
        return counts;
      });
      await report.step('host.content-check', 'pnpm --filter ./apps/server content:check', () => {
        const output = run('host-content-check', 'pnpm', ['--filter', './apps/server', 'content:check'], { cwd: project });
        return { summary: /Content check: .*/.exec(output)?.[0].replace(project, '<project>') };
      });
      await report.step('host.build', 'pnpm build (typecheck and build of server, web and admin)', () => {
        run('host-build', 'pnpm', ['build'], { cwd: project, env: { ...hostEnv } });
        return { server: existsSync(join(project, 'apps/server/dist/main.js')), web: existsSync(join(project, 'apps/web/.next/BUILD_ID')), admin: existsSync(join(project, 'apps/admin/dist/index.html')) };
      });
      await report.step('host.lint', 'pnpm lint', () => { run('host-lint', 'pnpm', ['lint'], { cwd: project }); return {}; });
      for (const cleanup of cleanups.splice(0)) { try { cleanup(); } catch { /* reported by the log */ } }
    }

    // ── compose tier (PLAN §2 steps 2–9) ─────────────────────────────────────────────────────
    if (want('compose') && tierCompose) {
      await ensureRegistry('proxy');
      const composeName = `zf-accept-${id}`;
      state.composeName = composeName; saveState();
      const taken = new Set();
      const ports = state.ports ?? {};
      for (const key of ['POSTGRES_PORT', 'REDIS_PORT', 'MINIO_PORT', 'MAILPIT_SMTP_PORT', 'MAILPIT_UI_PORT', 'SERVER_PORT', 'WEB_PORT', 'ADMIN_PORT', 'SMTP_SINK_PORT'])
        ports[key] ??= await freePort(taken);
      state.ports = ports; saveState();
      const web = `http://localhost:${ports.WEB_PORT}`, admin = `http://localhost:${ports.ADMIN_PORT}`;
      const envPath = join(project, '.env');
      writeFileSync(envPath, rewriteEnv(readFileSync(envPath, 'utf8'), {
        POSTGRES_PORT: ports.POSTGRES_PORT, REDIS_PORT: ports.REDIS_PORT, MINIO_PORT: ports.MINIO_PORT,
        MAILPIT_SMTP_PORT: ports.MAILPIT_SMTP_PORT, MAILPIT_UI_PORT: ports.MAILPIT_UI_PORT,
        SERVER_PORT: ports.SERVER_PORT, WEB_PORT: ports.WEB_PORT, ADMIN_PORT: ports.ADMIN_PORT,
        WEB_URL: web, SITE_URL: web, ADMIN_URL: admin, ACCOUNT_ORIGINS: `${admin},${web}`,
      }));
      chmodSync(envPath, 0o600);
      const composeArgs = ['compose', '-p', composeName, '--project-directory', project, '-f', join(project, 'docker-compose.yml'), '-f', join(rootDir, 'scripts/acceptance/compose.acceptance.yml')];
      const composeEnv = (pass) => ({ ...process.env, NPM_REGISTRY: registry.url, ACCEPT_NODE_ENV: pass === 2 ? 'test' : 'production', ACCEPT_TEST_FAKES: pass === 2 ? 'true' : 'false' });
      const compose = (name, args, pass = 1, extra = {}) => run(name, 'docker', [...composeArgs, ...args], { cwd: project, env: composeEnv(pass), ...extra });
      if (!options.keep) cleanups.push(() => compose('compose-down', ['down', '-v', '--rmi', 'local', '--remove-orphans']));

      await report.step('2.build', 'docker compose build (server, migrate, web, admin) through the local registry', () => {
        compose('compose-build', ['build'], 1, { timeout: 3_600_000 });
        const images = run('compose-images', 'docker', ['images', '--format', '{{.Repository}}:{{.Tag}}', '--filter', `reference=${composeName}-*`]).trim().split('\n').filter(Boolean);
        const frameworkFromRegistry = registry.requests.filter((request) => request.outcome === 'served' && request.path.endsWith('.tgz')).length;
        return { images, frameworkTarballsServed: frameworkFromRegistry, proxied: registry.requests.filter((request) => request.outcome === 'proxied').length };
      });
      await report.step('2.up', 'docker compose up: postgres, redis, storage, mailpit, migrate (one-shot), server, web, admin healthy', async () => {
        compose('compose-up', ['up', '-d', '--wait', '--wait-timeout', '300'], 1, { timeout: 900_000 });
        const migrate = compose('compose-ps', ['ps', '-a', '--format', '{{.Service}} {{.State}} {{.ExitCode}}']).trim();
        if (!/migrate exited 0/.test(migrate)) throw new Error(`migrate did not exit 0: ${migrate}`);
        const ready = await waitFor('server ready', async () => (await fetch(`http://127.0.0.1:${ports.SERVER_PORT}/api/health/ready`)).ok, 120_000);
        return { services: migrate.split('\n'), ready };
      });
      if (report.steps.find((step) => step.id === '2.up')?.status !== 'pass') throw new Error('The stack did not come up; later compose checks were not run (see logs/compose-up.log)');
      await report.step('2.setup-admin', 'Administrator setup through the migrate image (documented compose command)', async () => {
        let created = true;
        try {
          compose('compose-setup-admin', ['run', '--rm', '-e', 'BOOTSTRAP_ADMIN_USERNAME=acceptadmin', '-e', 'BOOTSTRAP_ADMIN_EMAIL=admin@accept.invalid',
            '-e', 'BOOTSTRAP_ADMIN_PASSWORD=Synthetic-Accept-9!x', 'migrate', 'node_modules/.bin/tsx', 'src/scripts/create-admin.ts']);
        } catch (error) {
          // A rerun against a kept stack: the administrator exists (setup never overwrites accounts).
          if (!state.adminCreated) throw error;
          created = false;
        }
        state.adminCreated = true; saveState();
        const plans = await (await fetch(`http://127.0.0.1:${ports.SERVER_PORT}/api/billing/plans`)).json();
        const list = plans.result ?? plans;
        const slugs = (Array.isArray(list) ? list : list.plans ?? list.data ?? []).map((plan) => plan.slug).filter(Boolean);
        return { administrator: 'acceptadmin', created, plans: slugs };
      });
      const context = {
        report, run, web, admin, api: `http://127.0.0.1:${ports.SERVER_PORT}/api`, mailpit: `http://127.0.0.1:${ports.MAILPIT_UI_PORT}`,
        smtpSinkPort: ports.SMTP_SINK_PORT, work, logs, project, composeName,
        adminCredentials: { username: 'acceptadmin', password: 'Synthetic-Accept-9!x' },
        secrets: () => readEnv(envPath),
        restartServer: async (pass) => {
          compose(`compose-server-pass${pass}`, ['up', '-d', '--no-deps', '--force-recreate', '--wait', 'server'], pass, { timeout: 600_000 });
          await waitFor('server ready', async () => (await fetch(`http://127.0.0.1:${ports.SERVER_PORT}/api/health/ready`)).ok, 120_000);
        },
        compose,
        bundles: { web: (path) => compose('web-bundle', ['exec', '-T', 'web', 'sh', '-c', `find /app -path '*/.next/*' -type f \\( -name '*.js' -o -name '*.html' -o -name '*.json' -o -name '*.rsc' \\) | head -5000 | xargs cat`], 1, { maxBuffer: 512 * 1024 * 1024 }),
          admin: () => compose('admin-bundle', ['exec', '-T', 'admin', 'sh', '-c', 'find /usr/share/nginx/html -type f | xargs cat'], 1, { maxBuffer: 256 * 1024 * 1024 }) },
      };
      await runChecks(context);
    }
  } finally {
    for (const cleanup of cleanups.reverse()) { try { cleanup(); } catch (error) { appendFileSync(join(logs, 'cleanup.log'), `${error.message}\n`); } }
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
    if (registry) await registry.close();
    report.meta.finishedAt = new Date().toISOString();
    report.save();
  }
  if (want('teardown') && !want('compose') && state.composeName) {
    // Explicit teardown after a `--keep` run: this project's containers, volumes and built images only.
    await report.step('teardown', `docker compose down -v --rmi local (${state.composeName})`, () => {
      run('compose-down', 'docker', ['compose', '-p', state.composeName, '--project-directory', project, '-f', join(project, 'docker-compose.yml'),
        '-f', join(rootDir, 'scripts/acceptance/compose.acceptance.yml'), 'down', '-v', '--rmi', 'local', '--remove-orphans'], { cwd: project });
      return { project: state.composeName };
    });
  }
  const failed = report.failed();
  process.stdout.write(`\n${report.steps.length} steps, ${failed.length} failed. Report: ${report.path}\n`);
  return failed.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; });
}
