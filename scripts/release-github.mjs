import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const releasePolicy = JSON.parse(readFileSync(new URL('../.github/release-policy.json', import.meta.url), 'utf8'));

export function githubApi(path) {
  return JSON.parse(execFileSync('gh', ['api', '--hostname', 'github.com', path], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
  }));
}

export function assertSuccessfulRun(run, { commit, workflow, event, allowInProgress = false }) {
  if (!/^[a-f0-9]{40}$/.test(commit)
    || !Number.isSafeInteger(run.id) || run.id < 1
    || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1
    || run.repository?.full_name !== releasePolicy.repository
    || run.head_repository?.full_name !== releasePolicy.repository
    || run.head_sha !== commit || run.head_branch !== releasePolicy.branch
    || run.path !== `.github/workflows/${workflow}` || run.event !== event
    || !((run.status === 'completed' && run.conclusion === 'success')
      || (allowInProgress && run.status === 'in_progress' && run.conclusion === null))) {
    throw new Error(`Required ${workflow} run did not succeed for the exact release commit on ${releasePolicy.branch}`);
  }
}

export function assertRequiredJobs(jobs, names = releasePolicy.requiredJobs) {
  for (const name of names) {
    const matches = jobs.filter((job) => job.name === name);
    if (matches.length !== 1 || matches[0].status !== 'completed' || matches[0].conclusion !== 'success') {
      throw new Error(`Required CI job did not succeed: ${name}`);
    }
  }
}

function isCurrentAutomaticRun(run, commit, env) {
  return env.GITHUB_ACTIONS === 'true' && env.GITHUB_SHA === commit
    && env.GITHUB_RUN_ID === String(run.id) && env.GITHUB_RUN_ATTEMPT === String(run.run_attempt)
    && env.GITHUB_REPOSITORY === releasePolicy.repository && env.GITHUB_EVENT_NAME === 'push'
    && env.GITHUB_REF === `refs/heads/${releasePolicy.branch}`
    && env.GITHUB_WORKFLOW_REF === `${releasePolicy.repository}/.github/workflows/${releasePolicy.automaticWorkflow}@refs/heads/${releasePolicy.branch}`;
}

export function assertAutomaticRun(run, commit, env = process.env) {
  assertSuccessfulRun(run, { commit, workflow: releasePolicy.automaticWorkflow, event: 'push',
    allowInProgress: isCurrentAutomaticRun(run, commit, env) });
}

export function verifyReleaseCI(commit, api = githubApi, env = process.env) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid release commit');
  const { repository, branch, ciWorkflow, automaticWorkflow, automaticCIPrefix } = releasePolicy;
  // The automatic workflow is still running while its preparation/publication
  // jobs execute. Only that exact run may use its already completed CI jobs.
  if (env.GITHUB_EVENT_NAME === 'push' && /^[1-9]\d*$/.test(env.GITHUB_RUN_ID ?? '')
    && env.GITHUB_WORKFLOW_REF === `${repository}/.github/workflows/${automaticWorkflow}@refs/heads/${branch}`) {
    const run = api(`repos/${repository}/actions/runs/${env.GITHUB_RUN_ID}`);
    if (!isCurrentAutomaticRun(run, commit, env)) throw new Error('Automatic release identity differs from the current GitHub run');
    assertAutomaticRun(run, commit, env);
    const { jobs } = api(`repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
    assertRequiredJobs(jobs ?? [], releasePolicy.requiredJobs.map(name => `${automaticCIPrefix}${name}`));
    return run;
  }
  const runs = [ciWorkflow, automaticWorkflow].flatMap(workflow => {
    const result = api(`repos/${repository}/actions/workflows/${workflow}/runs?head_sha=${commit}&event=push&branch=${branch}&per_page=100`);
    return result.workflow_runs ?? [];
  });
  // A newer failing/in-progress run must not be hidden by an older successful run.
  const run = runs.sort((a, b) => b.id - a.id)[0];
  if (!run) throw new Error('No main-branch CI run exists for the exact release commit');
  const automatic = run.path === `.github/workflows/${automaticWorkflow}`;
  assertSuccessfulRun(run, { commit, workflow: automatic ? automaticWorkflow : ciWorkflow, event: 'push' });
  const { jobs } = api(`repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
  assertRequiredJobs(jobs ?? [], releasePolicy.requiredJobs.map(name => `${automatic ? automaticCIPrefix : ''}${name}`));
  return run;
}

export function assertPreparationRun(run, commit, jobs = [], env = process.env) {
  if (run.path === `.github/workflows/${releasePolicy.automaticWorkflow}`) {
    assertAutomaticRun(run, commit, env);
    assertRequiredJobs(jobs, [releasePolicy.automaticPrepareJob]);
  } else {
    assertSuccessfulRun(run, { commit, workflow: releasePolicy.prepareWorkflow, event: 'workflow_dispatch' });
  }
}

export function assertReleaseReceipt(receipt, { commit, manifestSha256, run, ciRun, jobs = [], env = process.env }) {
  assertPreparationRun(run, commit, jobs, env);
  if (receipt.schemaVersion !== 1 || receipt.sourceCommit !== commit
    || !/^[a-f0-9]{64}$/.test(manifestSha256) || receipt.manifestSha256 !== manifestSha256
    || receipt.preparationRunId !== run.id || receipt.preparationRunAttempt !== run.run_attempt
    || receipt.ciRunId !== ciRun.id || receipt.ciRunAttempt !== ciRun.run_attempt
    || receipt.registry !== releasePolicy.registry
    || !/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(receipt.distTag)) {
    throw new Error('Release receipt does not match the approved artifact, workflow attempt or current CI evidence');
  }
}

export function verifyPreparedRelease(receipt, { commit, manifestSha256 }, api = githubApi, env = process.env) {
  if (!Number.isSafeInteger(receipt.preparationRunId) || receipt.preparationRunId < 1) throw new Error('Invalid preparation run ID');
  const run = api(`repos/${releasePolicy.repository}/actions/runs/${receipt.preparationRunId}`);
  const ciRun = verifyReleaseCI(commit, api, env);
  const { jobs = [] } = run.path === `.github/workflows/${releasePolicy.automaticWorkflow}`
    ? api(`repos/${releasePolicy.repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`) : {};
  assertReleaseReceipt(receipt, { commit, manifestSha256, run, ciRun, jobs, env });
  return { run, ciRun };
}
