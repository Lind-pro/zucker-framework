import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { releasePolicy } from './release-github.mjs';

export function workflowRun(commit, overrides = {}) {
  return { id: 100, run_attempt: 1, head_sha: commit, head_branch: releasePolicy.branch,
    repository: { full_name: releasePolicy.repository }, head_repository: { full_name: releasePolicy.repository },
    path: `.github/workflows/${releasePolicy.ciWorkflow}`, event: 'push', status: 'completed', conclusion: 'success', ...overrides };
}

export function githubFixture(directory, commit) {
  const ci = workflowRun(commit);
  const preparation = workflowRun(commit, { id: 200, event: 'workflow_dispatch', path: `.github/workflows/${releasePolicy.prepareWorkflow}` });
  const jobs = releasePolicy.requiredJobs.map((name) => ({ name, status: 'completed', conclusion: 'success' }));
  const artifact = (prefix, run) => ({ name: `${prefix}-${run.id}-${run.run_attempt}`, expired: false, workflow_run: { head_sha: commit } });
  const data = { ci, preparation, jobs,
    ciArtifacts: [artifact(releasePolicy.ciArtifactPrefix, ci)],
    releaseArtifacts: [artifact(releasePolicy.releaseArtifactPrefix, preparation)] };
  const file = join(directory, 'github-fixture.json');
  const save = () => writeFileSync(file, JSON.stringify(data));
  save();
  const bin = join(directory, 'bin'); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(${JSON.stringify(file)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(join(directory, 'github-calls.jsonl'))}, JSON.stringify(args) + '\\n');
if (args[0] === 'api') {
  const path = args.at(-1);
  if (path.includes('/workflows/${releasePolicy.automaticWorkflow}/')) console.log(JSON.stringify({ workflow_runs: data.automaticRuns ?? [] }));
  else if (path.includes('/workflows/')) console.log(JSON.stringify({ workflow_runs: data.runs ?? [data.ci] }));
  else if (path.includes('/jobs?')) console.log(JSON.stringify({ jobs: data.jobs }));
  else if (path.includes('/artifacts?')) console.log(JSON.stringify({ artifacts: data.ci.id === data.preparation.id
    ? [...data.ciArtifacts, ...data.releaseArtifacts] : path.includes('/' + data.ci.id + '/') ? data.ciArtifacts : data.releaseArtifacts }));
  else if (path.endsWith('/' + data.preparation.id)) console.log(JSON.stringify(data.preparation));
  else if (path.endsWith('/' + data.ci.id)) console.log(JSON.stringify(data.ci));
  else throw new Error('Unexpected fixture GitHub API path: ' + path);
} else if (args[0] === 'run' && args[1] === 'download') {
  const source = args[args.indexOf('--name') + 1].startsWith('${releasePolicy.ciArtifactPrefix}-') ? data.ciDirectory : data.preparedDirectory;
  if (!source) throw new Error('No fixture artifact directory configured');
  fs.cpSync(source, args[args.indexOf('--dir') + 1], { recursive: true });
} else throw new Error('Unexpected gh command');
`, { mode: 0o755 });
  return { data, save, ci, preparation };
}

export function releaseReceipt(commit, manifestSha256) {
  return { schemaVersion: 1, sourceCommit: commit, manifestSha256,
    preparationRunId: 200, preparationRunAttempt: 1, ciRunId: 100, ciRunAttempt: 1,
    registry: releasePolicy.registry, distTag: 'latest' };
}
