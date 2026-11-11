import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// WP 4.2 (Sonnet): the `content:check` command line (arguments, CONTENT_DIR, exit codes, output streams).
const server = resolve('.'), tsx = join(server, 'node_modules/.bin/tsx'), cli = join(server, 'src/content/content-check.cli.ts');
function check(args: string[], env: Record<string, string | undefined> = {}, cwd = server) {
  // tsx reads decorator settings from the tsconfig of the working directory; `pnpm content:check` runs in
  // this package, so a foreign working directory gets the package tsconfig explicitly.
  const environment: NodeJS.ProcessEnv = { ...process.env, TSX_TSCONFIG_PATH: join(server, 'tsconfig.json'), CONTENT_DIR: undefined, ...env };
  for (const key of Object.keys(environment)) if (environment[key] === undefined) delete environment[key];
  const result = spawnSync(tsx, [cli, ...args], { cwd, env: environment, encoding: 'utf8', timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
const scratch = <T>(work: (root: string) => T): T => {
  const root = mkdtempSync(join(tmpdir(), 'zf-content-cli-'));
  try { return work(root); } finally { rmSync(root, { recursive: true, force: true }); }
};
const valid = (root: string) => { cpSync(join(server, 'content'), root, { recursive: true }); return root; };
const broken = (root: string) => { mkdirSync(join(root, 'pages'), { recursive: true }); writeFileSync(join(root, 'pages/Bad Name.txt'), 'SYNTHETIC-FILE-BODY-SENTINEL'); return root; };

describe('content:check command line', () => {
  it('checks the argument directory, prints the summary on stdout and exits 0 when everything is valid', () => scratch(root => {
    const dir = valid(join(root, 'ok')), result = check([dir]);
    expect(result.status).toBe(0); expect(result.stderr).toBe('');
    expect(result.stdout).toMatch(/^Content check: \d+ valid, 0 invalid \(/); expect(result.stdout).toContain(dir);
  }));

  it('exits 1 with issues on stderr and the summary on stdout, and never prints file contents', () => scratch(root => {
    const result = check([broken(join(root, 'bad'))]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('invalid pages/Bad Name.txt: ');
    expect(result.stdout.trim().split('\n')).toHaveLength(1); expect(result.stdout).toMatch(/0 valid, 1 invalid/);
    expect(result.stdout + result.stderr).not.toContain('SYNTHETIC-FILE-BODY-SENTINEL');
  }));

  it('uses CONTENT_DIR when no argument is given, and the argument wins over CONTENT_DIR', () => scratch(root => {
    const good = valid(join(root, 'ok')), bad = broken(join(root, 'bad'));
    expect(check([], { CONTENT_DIR: good }).status).toBe(0);
    expect(check([], { CONTENT_DIR: bad }).status).toBe(1);
    expect(check([good], { CONTENT_DIR: bad }).status).toBe(0);
    expect(check([bad], { CONTENT_DIR: good }).status).toBe(1);
    expect(check(['--', good], { CONTENT_DIR: bad }).status).toBe(0);
  }));

  it('defaults to ./content of the working directory, also when CONTENT_DIR is empty or blank', () => scratch(root => {
    const project = join(root, 'project'); mkdirSync(project); valid(join(project, 'content'));
    for (const value of [undefined, '', '   ']) {
      const result = check([], { CONTENT_DIR: value }, project);
      expect(result.status, JSON.stringify(value)).toBe(0); expect(result.stdout).toContain(join(project, 'content'));
    }
    // A relative argument resolves against the working directory.
    expect(check(['content'], {}, project).status).toBe(0);
  }));

  it('fails with a clear message for a missing directory', () => scratch(root => {
    const missing = join(root, 'nope'), result = check([missing]);
    expect(result.status).toBe(1); expect(result.stderr).toContain('invalid .: Content directory not found');
    expect(result.stdout).toMatch(/0 valid, 1 invalid/);
    const viaEnv = check([], { CONTENT_DIR: missing }); expect(viaEnv.status).toBe(1);
    // A regular file is not a directory either.
    writeFileSync(join(root, 'file'), 'x'); expect(check([join(root, 'file')]).status).toBe(1);
  }));

  it('rejects extra arguments and flags with a usage message and exit 1', () => scratch(root => {
    const good = valid(join(root, 'ok'));
    for (const args of [[good, good], ['--fix'], ['-h'], [good, '--json']]) {
      const result = check(args);
      expect(result.status, args.join(' ')).toBe(1); expect(result.stderr).toContain('usage: content:check [directory]'); expect(result.stdout).toBe('');
    }
  }));
});
