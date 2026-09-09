import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const releasePolicy = JSON.parse(readFileSync(new URL('../.github/release-policy.json', import.meta.url), 'utf8'));

export function githubApi(path) {
  return JSON.parse(execFileSync('gh', ['api', '--hostname', 'github.com', path], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
  }));
}

export function assertSuccessfulRun(run, { commit, workflow, event }) {
  if (!/^[a-f0-9]{40}$/.test(commit)
    || !Number.isSafeInteger(run.id) || run.id < 1
    || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1
    || run.repository?.full_name !== releasePolicy.repository
    || run.head_repository?.full_name !== releasePolicy.repository
    || run.head_sha !== commit || run.head_branch !== releasePolicy.branch
    || run.path !== `.github/workflows/${workflow}` || run.event !== event
    || run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error(`Required ${workflow} run did not succeed for the exact release commit on ${releasePolicy.branch}`);
  }
}

export function assertRequiredJobs(jobs) {
  for (const name of releasePolicy.requiredJobs) {
    const matches = jobs.filter((job) => job.name === name);
    if (matches.length !== 1 || matches[0].status !== 'completed' || matches[0].conclusion !== 'success') {
      throw new Error(`Required CI job did not succeed: ${name}`);
    }
  }
}

export function verifyReleaseCI(commit, api = githubApi) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid release commit');
  const { repository, branch, ciWorkflow } = releasePolicy;
  const result = api(`repos/${repository}/actions/workflows/${ciWorkflow}/runs?head_sha=${commit}&event=push&branch=${branch}&per_page=100`);
  // A newer failing/in-progress run must not be hidden by an older successful run.
  const run = [...(result.workflow_runs ?? [])].sort((a, b) => b.id - a.id)[0];
  if (!run) throw new Error('No main-branch CI run exists for the exact release commit');
  assertSuccessfulRun(run, { commit, workflow: ciWorkflow, event: 'push' });
  const { jobs } = api(`repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
  assertRequiredJobs(jobs ?? []);
  return run;
}

export function assertReleaseReceipt(receipt, { commit, manifestSha256, run, ciRun }) {
  assertSuccessfulRun(run, { commit, workflow: releasePolicy.prepareWorkflow, event: 'workflow_dispatch' });
  if (receipt.schemaVersion !== 1 || receipt.sourceCommit !== commit
    || !/^[a-f0-9]{64}$/.test(manifestSha256) || receipt.manifestSha256 !== manifestSha256
    || receipt.preparationRunId !== run.id || receipt.preparationRunAttempt !== run.run_attempt
    || receipt.ciRunId !== ciRun.id || receipt.ciRunAttempt !== ciRun.run_attempt
    || receipt.registry !== releasePolicy.registry
    || !/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(receipt.distTag)) {
    throw new Error('Release receipt does not match the approved artifact, workflow attempt or current CI evidence');
  }
}

export function verifyPreparedRelease(receipt, { commit, manifestSha256 }, api = githubApi) {
  if (!Number.isSafeInteger(receipt.preparationRunId) || receipt.preparationRunId < 1) throw new Error('Invalid preparation run ID');
  const run = api(`repos/${releasePolicy.repository}/actions/runs/${receipt.preparationRunId}`);
  const ciRun = verifyReleaseCI(commit, api);
  assertReleaseReceipt(receipt, { commit, manifestSha256, run, ciRun });
  return { run, ciRun };
}
