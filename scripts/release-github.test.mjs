import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSuccessfulRun, assertRequiredJobs, assertReleaseReceipt, verifyReleaseCI, releasePolicy, assertAutomaticRun } from './release-github.mjs';
import { workflowRun, releaseReceipt } from './release-test-fixtures.mjs';

const commit = 'a'.repeat(40);
const jobs = releasePolicy.requiredJobs.map(name => ({ name, status: 'completed', conclusion: 'success' }));
const criteria = { commit, workflow: releasePolicy.ciWorkflow, event: 'push' };

test('requires the exact commit, repository, main branch and CI workflow', () => {
  assertSuccessfulRun(workflowRun(commit), criteria);
  for (const change of [
    { head_sha: 'b'.repeat(40) }, { repository: { full_name: 'foreign/repo' } },
    { head_repository: { full_name: 'foreign/repo' } }, { head_branch: 'feature' },
    { path: '.github/workflows/other.yml' }, { event: 'pull_request' },
    { status: 'in_progress', conclusion: null }, { conclusion: 'failure' },
  ]) assert.throws(() => assertSuccessfulRun(workflowRun(commit, change), criteria), /did not succeed/);
});

test('refuses skipped, failed, missing or ambiguous required jobs', () => {
  assertRequiredJobs(jobs);
  for (const conclusion of ['skipped', 'failure', 'cancelled']) {
    assert.throws(() => assertRequiredJobs([jobs[0], { ...jobs[1], conclusion }]), /Required CI job/);
  }
  assert.throws(() => assertRequiredJobs([jobs[0]]), /Required CI job/);
  assert.throws(() => assertRequiredJobs([...jobs, jobs[0]]), /Required CI job/);
});

test('uses the latest CI run and current attempt rather than any historical success', () => {
  const api = (path) => path.includes('/jobs?') ? { jobs } : { workflow_runs: [workflowRun(commit)] };
  assert.equal(verifyReleaseCI(commit, api, {}).id, 100);
  assert.throws(() => verifyReleaseCI(commit, () => ({ workflow_runs: [workflowRun(commit), workflowRun(commit, { id: 101, conclusion: 'failure' })] }), {}), /did not succeed/);
  assert.throws(() => verifyReleaseCI(commit, () => ({ workflow_runs: [] }), {}), /No main-branch CI/);
});

const automaticEnvironment = {
  GITHUB_ACTIONS: 'true', GITHUB_SHA: commit, GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1',
  GITHUB_REPOSITORY: releasePolicy.repository, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main',
  GITHUB_WORKFLOW_REF: `${releasePolicy.repository}/.github/workflows/publish.yml@refs/heads/main`,
};
const automaticRun = () => workflowRun(commit, { path: '.github/workflows/publish.yml', status: 'in_progress', conclusion: null });

test('only the current push pipeline can use completed checks while the workflow is running', () => {
  const run = automaticRun();
  const automaticJobs = jobs.map(job => ({ ...job, name: `CI / ${job.name}` }));
  const api = path => path.includes('/jobs?') ? { jobs: automaticJobs } : run;
  assert.equal(verifyReleaseCI(commit, api, automaticEnvironment).id, 100);
  for (const change of [
    { GITHUB_SHA: 'b'.repeat(40) }, { GITHUB_RUN_ID: '101' }, { GITHUB_RUN_ATTEMPT: '2' },
    { GITHUB_REPOSITORY: 'foreign/repo' }, { GITHUB_REF: 'refs/heads/feature' },
    { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_WORKFLOW_REF: 'foreign/workflow' },
  ]) assert.throws(() => assertAutomaticRun(run, commit, { ...automaticEnvironment, ...change }), /did not succeed/);
  assert.throws(() => assertAutomaticRun({ ...run, event: 'workflow_run' }, commit, automaticEnvironment), /did not succeed/);
  automaticJobs[1].conclusion = 'skipped';
  assert.throws(() => verifyReleaseCI(commit, api, automaticEnvironment), /Required CI job/);
});

test('same-run receipts also require successful preparation in the exact attempt', () => {
  const run = automaticRun();
  const receipt = { ...releaseReceipt(commit, 'c'.repeat(64)), preparationRunId: 100 };
  const expected = { commit, manifestSha256: receipt.manifestSha256, run, ciRun: run, env: automaticEnvironment,
    jobs: [{ name: releasePolicy.automaticPrepareJob, status: 'completed', conclusion: 'success' }] };
  assertReleaseReceipt(receipt, expected);
  assert.throws(() => assertReleaseReceipt(receipt, { ...expected, jobs: [] }), /Required CI job/);
  assert.throws(() => assertReleaseReceipt(receipt, { ...expected, env: { ...automaticEnvironment, GITHUB_RUN_ATTEMPT: '2' } }), /did not succeed/);
  assert.throws(() => assertReleaseReceipt({ ...receipt, ciRunAttempt: 2 }, expected), /does not match/);
});

test('binds approval to the exact manifest, preparation attempt and CI evidence', () => {
  const hash = 'c'.repeat(64);
  const receipt = releaseReceipt(commit, hash);
  const run = workflowRun(commit, { id: 200, path: '.github/workflows/release.yml', event: 'workflow_dispatch' });
  const expected = { commit, manifestSha256: hash, run, ciRun: workflowRun(commit) };
  assertReleaseReceipt(receipt, expected);
  for (const change of [{ manifestSha256: 'd'.repeat(64) }, { preparationRunId: 201 }, { preparationRunAttempt: 2 }, { ciRunAttempt: 2 }, { registry: 'https://other.example/' }]) {
    assert.throws(() => assertReleaseReceipt({ ...receipt, ...change }, expected), /does not match/);
  }
});
