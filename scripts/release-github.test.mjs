import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSuccessfulRun, assertRequiredJobs, assertReleaseReceipt, verifyReleaseCI, releasePolicy } from './release-github.mjs';
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
  assert.equal(verifyReleaseCI(commit, api).id, 100);
  assert.throws(() => verifyReleaseCI(commit, () => ({ workflow_runs: [workflowRun(commit), workflowRun(commit, { id: 101, conclusion: 'failure' })] })), /did not succeed/);
  assert.throws(() => verifyReleaseCI(commit, () => ({ workflow_runs: [] })), /No main-branch CI/);
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
