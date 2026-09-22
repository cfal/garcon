import { expect, test, spyOn } from 'bun:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { gitRpcFixture } from './git-rpc-fixture.js';
import { runGit } from '../../git/run.js';
import { RemoteGitServices } from '../remote-git.js';
import { GitResultTransfers } from '../git-results.js';

for (const dialer of ['controller', 'worker'] as const) {
  test(`Git queries, review proofs and mutations use the repository host with ${dialer} dialing`, async () => {
    const fixture = await gitRpcFixture(dialer);
    const { projectPath, root } = fixture;
    const request = { projectPath };
    try {
      const git = await fixture.node.getGitService();
      expect((await git.getRepoInfo(request)).isGitRepository).toBe(true);
      expect((await git.getStatus(request)).branch).toBe('main');
      expect((await git.getBranches(request)).branches).toContain('main');
      expect((await git.getRefs(request)).refs.length).toBeGreaterThan(0);
      expect((await git.getQuickSummary(request)).status).toBe('ready');
      expect((await git.getWorkingTreeFingerprint(request)).status).toBe('ready');
      expect((await git.getHistoryCommits(request)).commits.length).toBe(1);
      expect((await git.getCommitSnapshot({ ...request, commit: 'HEAD', context: 3 })).status).toBe('ready');
      expect((await git.getFileHistory({ ...request, file: 'example.txt' })).commits.length).toBe(1);
      expect((await git.getBlame({ ...request, file: 'example.txt' })).lines.length).toBe(1);
      expect((await git.getGraph(request)).commits.length).toBe(1);
      expect((await git.getConflicts(request)).conflicts).toEqual([]);
      expect((await git.getTargetCandidates(request)).targets.length).toBe(1);
      expect((await git.getWorktrees(request)).worktrees.length).toBe(1);
      const comparison = { ...request, from: { kind: 'revision' as const, revision: 'HEAD' }, to: { kind: 'working-tree' as const }, mode: 'direct' as const, context: 3 };
      expect((await git.getComparisonSnapshot(comparison)).status).toBe('ready');
      await fs.writeFile(path.join(projectPath, 'example.txt'), 'changed\n');
      const snapshot = await git.getWorkbenchSnapshot({ ...request, mode: 'working', context: 3 });
      if (snapshot.status !== 'ready') throw new Error('Expected snapshot');
      const document = { nodeId: snapshot.nodeId, instanceId: snapshot.instanceId, documentId: snapshot.reviewSummary.documentId };
      const bodies = await git.getReviewDocumentFileBodies({ ...request, document, files: ['example.txt'], purpose: 'visible' });
      if (bodies.status !== 'ready') throw new Error('Expected patch');
      const body = bodies.files['example.txt'];
      expect(body.patch).toContain('+changed');
      await expect(git.getReviewDocumentFileBodies({ ...request, document: { ...document, instanceId: 'old' }, files: ['example.txt'], purpose: 'visible' }))
        .rejects.toMatchObject({ code: 'GIT_STALE_DOCUMENT' });
      await git.stageHunk({ ...request, document, bodyFingerprint: body.bodyFingerprint, patchDigest: body.patchDigest!, file: 'example.txt', hunkIndex: 0, mode: 'stage', contextLines: 3 });
      await git.commitIndex({ ...request, message: 'staged on node' });
      expect((await git.getStatus(request)).modified).toEqual([]);
      await git.createBranch({ ...request, branch: 'other' });
      await git.checkout({ ...request, ref: 'main' });
      await fs.writeFile(path.join(projectPath, 'example.txt'), 'stash\n');
      await git.createStash({ ...request, message: 'synthetic stash' });
      expect((await git.getStashes(request)).stashes.length).toBe(1);
      await git.popStash({ ...request, stashRef: 'stash@{0}' });
      await git.discard({ ...request, file: 'example.txt' });
      const destination = path.join(root, 'linked');
      await git.createWorktree({ ...request, worktreePath: destination, branch: 'linked' });
      await git.removeWorktree({ ...request, worktreePath: destination });
      await fs.writeFile(path.join(projectPath, 'new.txt'), 'new\n');
      await fs.writeFile(path.join(projectPath, 'example.txt'), 'context change\n');
      await git.stagePaths({ ...request, paths: ['example.txt'], mode: 'stage' });
      expect((await git.collectCommitMessageContext({ ...request, files: ['example.txt'] })).diff).toContain('context change');
      await git.deleteUntracked({ ...request, file: 'new.txt' });
      expect((await git.getRemotes(request)).remotes).toEqual([]);
      expect((await git.getRemoteStatus(request)).hasRemote).toBe(false);
    } finally { await fixture.dispose(); }
  }, 30_000);
}

test('lost mutation confirmation never replays a completed commit', async () => {
  const fixture = await gitRpcFixture();
  const service = await fixture.local.getGitService();
  const commit = service.commitIndex.bind(service);
  const dispatched = spyOn(service, 'commitIndex').mockImplementation(async (request, options) => {
    const result = await commit(request, options);
    await fixture.controller.dispose();
    return result;
  });
  try {
    const git = await fixture.node.getGitService();
    await fs.writeFile(path.join(fixture.projectPath, 'new.txt'), 'new\n');
    await git.stagePaths({ projectPath: fixture.projectPath, paths: ['new.txt'], mode: 'stage' });
    await expect(git.commitIndex({ projectPath: fixture.projectPath, message: 'confirmed side effect' }))
      .rejects.toMatchObject({ code: 'GIT_MUTATION_OUTCOME_UNKNOWN' });
    expect(dispatched).toHaveBeenCalledTimes(1);
    expect((await runGit(fixture.projectPath, ['log', '-1', '--format=%s'])).stdout.trim()).toBe('confirmed side effect');
  } finally { dispatched.mockRestore(); await fixture.dispose(); }
}, 30_000);

test('invalid Git requests never acquire a remote session', async () => {
  const services = new RemoteGitServices(() => { throw new Error('Unexpected session access'); });
  await expect(services.git.stagePaths({ projectPath: '/repo', paths: ['x'.repeat(300_000)], mode: 'stage' }))
    .rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
  await expect(services.gh.getPullRequest({ projectPath: '/repo', number: -1 }))
    .rejects.toMatchObject({ code: 'GIT_INVALID_INPUT' });
});

for (const fault of ['offset', 'eof', 'base64', 'utf8', 'node', 'cancel'] as const) {
  test(`rejects a ${fault} query fault and closes its captured result handle`, async () => {
    const fixture = await gitRpcFixture();
    const local = await fixture.local.getGitService();
    const status = await local.getStatus({ projectPath: fixture.projectPath });
    const queried = spyOn(local, 'getStatus').mockResolvedValue({ ...status, untracked: ['x'.repeat(600_000)],
      ...(fault === 'node' ? { nodeId: 'other' } : {}) });
    const read = GitResultTransfers.prototype.readChunk;
    const controller = new AbortController();
    const chunks = spyOn(GitResultTransfers.prototype, 'readChunk').mockImplementation(function (request, signal) {
      const result = read.call(this, request, signal);
      if (fault === 'cancel') controller.abort();
      if (fault === 'offset') return { ...result, offset: result.offset + 1 };
      if (fault === 'eof') return { ...result, eof: !result.eof };
      if (fault === 'base64') return { ...result, data: '?' };
      if (fault === 'utf8') {
        const bytes = Buffer.from(result.data, 'base64'); bytes[0] = 255;
        return { ...result, data: bytes.toString('base64') };
      }
      return result;
    });
    const close = spyOn(GitResultTransfers.prototype, 'close');
    try {
      const git = await fixture.node.getGitService();
      const pending = git.getStatus({ projectPath: fixture.projectPath }, { signal: controller.signal });
      if (fault === 'cancel') await expect(pending).rejects.toThrow();
      else await expect(pending).rejects.toMatchObject({ code: 'GIT_INVALID_RESULT' });
      expect(close).toHaveBeenCalledTimes(1);
      expect(queried).toHaveBeenCalledTimes(1);
    } finally {
      chunks.mockRestore(); close.mockRestore(); queried.mockRestore();
      await fixture.dispose();
    }
  }, 10_000);
}

test('an invalid mutation reply is uncertain but a pre-dispatch disconnect is definite', async () => {
  const fixture = await gitRpcFixture();
  const local = await fixture.local.getGitService();
  const create = local.createBranch.bind(local);
  const dispatched = spyOn(local, 'createBranch').mockImplementation(async (request, options) => ({ ...await create(request, options), instanceId: 'wrong' }));
  try {
    const git = await fixture.node.getGitService();
    await expect(git.createBranch({ projectPath: fixture.projectPath, branch: 'created' }))
      .rejects.toMatchObject({ code: 'GIT_MUTATION_OUTCOME_UNKNOWN' });
    await fixture.controller.dispose();
    await expect(git.createBranch({ projectPath: fixture.projectPath, branch: 'not-created' }))
      .rejects.toMatchObject({ outcome: 'not-dispatched' });
    expect(dispatched).toHaveBeenCalledTimes(1);
    expect((await runGit(fixture.projectPath, ['branch', '--list', 'created'])).stdout).toContain('created');
  } finally { dispatched.mockRestore(); await fixture.dispose(); }
});
