import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { releasePolicy, githubApi, assertSuccessfulRun, verifyReleaseCI, verifyPreparedRelease } from './release-github.mjs';

const [command, ...args] = process.argv.slice(2);
function option(name) {
  const i = args.indexOf(name);
  if (i < 0 || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${name} is required`);
  return args[i + 1];
}
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function loadBundle(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, 'release-manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 2 || manifest.sourceDirty !== false
    || manifest.sourceCommit !== commit || manifest.sourceTree !== tree
    || !Array.isArray(manifest.packages) || !manifest.packages.length) {
    throw new Error('The downloaded bundle must match this exact clean source commit');
  }
  if (!existsSync(join(directory, 'consumer-verification.json'))) throw new Error('Consumer verification report is missing');
  return { manifest, manifestSha256: sha256(join(directory, 'release-manifest.json')) };
}

function download(run, prefix, directory) {
  if (existsSync(directory) && (lstatSync(directory).isSymbolicLink() || readdirSync(directory).length)) {
    throw new Error('Refusing to overwrite an existing bundle directory');
  }
  const name = `${prefix}-${run.id}-${run.run_attempt}`;
  const result = githubApi(`repos/${releasePolicy.repository}/actions/runs/${run.id}/artifacts?per_page=100`);
  const matches = (result.artifacts ?? []).filter((artifact) => artifact.name === name);
  if (matches.length !== 1 || matches[0].expired || matches[0].workflow_run?.head_sha !== commit) {
    throw new Error('The exact immutable workflow artifact is missing or expired');
  }
  mkdirSync(directory, { recursive: true });
  execFileSync('gh', ['run', 'download', String(run.id), '--repo', `github.com/${releasePolicy.repository}`,
    '--name', name, '--dir', directory], { stdio: 'inherit', timeout: 60000 });
}

if (command === 'download-ci') {
  const run = verifyReleaseCI(commit);
  const directory = resolve(option('--output'));
  download(run, releasePolicy.ciArtifactPrefix, directory);
  const { manifestSha256 } = loadBundle(directory);
  writeFileSync(join(directory, 'ci-evidence.json'), `${JSON.stringify({ runId: run.id, runAttempt: run.run_attempt, sourceCommit: commit, manifestSha256 }, null, 2)}\n`);
  console.log(`Downloaded verified CI bundle: ${manifestSha256}`);
} else if (command === 'seal') {
  const directory = resolve(option('--bundle'));
  const { manifestSha256 } = loadBundle(directory);
  const ciRun = verifyReleaseCI(commit);
  const evidence = JSON.parse(readFileSync(join(directory, 'ci-evidence.json'), 'utf8'));
  if (evidence.runId !== ciRun.id || evidence.runAttempt !== ciRun.run_attempt
    || evidence.sourceCommit !== commit || evidence.manifestSha256 !== manifestSha256) throw new Error('CI evidence changed; prepare a new bundle');
  const distTag = option('--tag');
  if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(distTag)) throw new Error('Invalid distribution tag');
  const preparationRunId = Number(process.env.GITHUB_RUN_ID);
  const preparationRunAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  if (process.env.GITHUB_ACTIONS !== 'true' || !Number.isSafeInteger(preparationRunId) || preparationRunId < 1
    || !Number.isSafeInteger(preparationRunAttempt) || preparationRunAttempt < 1
    || process.env.GITHUB_SHA !== commit) throw new Error('Only the preparation workflow can seal a bundle');
  const receipt = { schemaVersion: 1, sourceCommit: commit, manifestSha256, preparationRunId, preparationRunAttempt,
    ciRunId: ciRun.id, ciRunAttempt: ciRun.run_attempt, registry: releasePolicy.registry, distTag };
  const path = join(directory, 'release-receipt.json');
  if (existsSync(path)) throw new Error('Refusing to replace an existing release receipt');
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
  const summary = `Source commit: ${commit}\n\nPreparation run: ${preparationRunId}\n\nApproved manifest SHA-256: ${manifestSha256}\n\nRegistry: ${receipt.registry}\n\nDistribution tag: ${distTag}\n`;
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
} else if (command === 'download-prepared') {
  const runId = option('--run');
  const expected = option('--manifest-sha256');
  if (!/^[1-9]\d*$/.test(runId) || !Number.isSafeInteger(Number(runId)) || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Invalid preparation run or approved manifest SHA-256');
  const run = githubApi(`repos/${releasePolicy.repository}/actions/runs/${runId}`);
  assertSuccessfulRun(run, { commit, workflow: releasePolicy.prepareWorkflow, event: 'workflow_dispatch' });
  const directory = resolve(option('--output'));
  download(run, releasePolicy.releaseArtifactPrefix, directory);
  const { manifestSha256 } = loadBundle(directory);
  if (manifestSha256 !== expected) throw new Error('Downloaded manifest differs from the approved SHA-256');
  const receipt = JSON.parse(readFileSync(join(directory, 'release-receipt.json'), 'utf8'));
  if (receipt.preparationRunId !== Number(runId)) throw new Error('Preparation receipt came from another workflow run');
  verifyPreparedRelease(receipt, { commit, manifestSha256 });
  console.log(`Approved bundle downloaded unchanged: ${manifestSha256}`);
} else {
  throw new Error('Use download-ci, seal, or download-prepared');
}
