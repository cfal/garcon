import { describe, it, expect } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { GitDomainError } from '../git-types.js';
import { createGitService } from '../git-service.js';
import { runGitTraced } from '../run.js';

// Minimal classifier stub for toHttpError tests
function mockClassifyGitError(error) {
  const msg = error?.message || '';
  if (msg.includes('hostname')) {
    return { code: 'NETWORK', status: 502, message: 'Could not reach the remote host.', details: 'Verify network access.' };
  }
  return { code: 'UNKNOWN', status: 500, message: msg || 'Git operation failed.' };
}

const mockAgents = {
  runSingleQuery: () => Promise.resolve('chore: stub'),
};

async function runGitCommand(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`git ${args.join(' ')} failed: ${stderr || stdout}`));
    });
  });
}

async function initRepoWithCommit(projectPath) {
  await runGitCommand(projectPath, ['init']);
  await runGitCommand(projectPath, ['config', 'user.email', 'test@example.com']);
  await runGitCommand(projectPath, ['config', 'user.name', 'Test User']);
  await fs.writeFile(path.join(projectPath, 'a.txt'), 'one\n', 'utf-8');
  await runGitCommand(projectPath, ['add', 'a.txt']);
  await runGitCommand(projectPath, ['commit', '-m', 'initial']);
}

describe('GitDomainError', () => {
  it('extends Error with name and code', () => {
    const err = new GitDomainError('INVALID_INPUT', 'bad input');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('GitDomainError');
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.message).toBe('bad input');
  });
});

describe('createGitService', () => {
  const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

	  it('returns an object with all expected service methods', () => {
	    const expectedMethods = [
	      'getStatus', 'getDiff', 'getFileWithDiff', 'initialCommit',
	      'commit', 'getBranches', 'checkout', 'createBranch',
	      'getCommits', 'getCommitDiff', 'generateCommitMessageForFiles',
	      'getRemoteStatus', 'getRemotes', 'fetch', 'pull', 'push',
	      'discard', 'deleteUntracked', 'getFileReviewData',
	      'getFileReviewDataBatch', 'getChangesTree', 'getChangesStats', 'stageSelection', 'stageHunk',
	      'getWorktrees', 'getTargetCandidates', 'createWorktree', 'removeWorktree',
	      'commitIndex', 'stageFile', 'revertLastCommit',
	      'getConflicts', 'getConflictDetails', 'acceptConflictSide', 'markConflictResolved',
	      'getStashes', 'createStash', 'applyStash', 'popStash', 'dropStash',
	      'getFileHistory', 'getBlame', 'getGraph', 'getCompare',
	      'toHttpError',
	    ];
    for (const method of expectedMethods) {
      expect(typeof git[method]).toBe('function');
    }
  });
});

describe('getTargetCandidates', () => {
  it('reports the current branch on the chat-project candidate', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-targets-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ['branch', '-M', 'work']);

      const { targets } = await git.getTargetCandidates({ projectPath });
      const chatProject = targets.find((target) => target.source === 'chat-project');

      expect(chatProject).toBeDefined();
      expect(chatProject.isCurrent).toBe(true);
      expect(chatProject.branch).toBe('work');
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});

describe('getChangesTree', () => {
  it('records git command duration and byte counts when trace is provided', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-trace-'));
    try {
      await runGitCommand(projectPath, ['init']);
      const trace = [];
      await runGitTraced(projectPath, ['rev-parse', '--is-inside-work-tree'], trace);

      expect(trace).toHaveLength(1);
      expect(trace[0]).toMatchObject({
        args: ['rev-parse', '--is-inside-work-tree'],
      });
      expect(trace[0].durationMs).toBeGreaterThanOrEqual(0);
      expect(trace[0].stdoutBytes).toBeGreaterThan(0);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('skips numstat by default and marks stats pending', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-tree-fast-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(path.join(projectPath, 'a.txt'), 'one\ntwo\n', 'utf-8');
      const trace = [];
      const tree = await git.getChangesTree({ projectPath, trace });

      expect(tree.statsState).toBe('pending');
      expect(trace.some((entry) => entry.args.includes('--numstat'))).toBe(false);
      expect(trace).toHaveLength(2);
      expect(tree.root[0]).toMatchObject({
        path: 'a.txt',
        additions: 0,
        deletions: 0,
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('loads numstat when includeStats is true', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-tree-stats-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(path.join(projectPath, 'a.txt'), 'one\ntwo\n', 'utf-8');
      const trace = [];
      const tree = await git.getChangesTree({ projectPath, includeStats: true, trace });

      expect(tree.statsState).toBe('loaded');
      expect(trace.some((entry) => entry.args.includes('--numstat'))).toBe(true);
      expect(tree.root[0]).toMatchObject({
        path: 'a.txt',
        additions: 1,
        deletions: 0,
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('expands untracked directories to untracked files', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-tree-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await runGitCommand(projectPath, ['init']);
      await fs.mkdir(path.join(projectPath, 'newdir/subdir'), { recursive: true });
      await fs.writeFile(path.join(projectPath, 'newdir/subdir/file.txt'), 'hello\n', 'utf-8');

      const tree = await git.getChangesTree({ projectPath });
      expect(tree.root).toMatchObject([
        {
          path: 'newdir',
          name: 'newdir',
          kind: 'directory',
          changeKind: 'untracked',
          staged: false,
          hasUnstaged: true,
          children: [
            {
              path: 'newdir/subdir',
              name: 'subdir',
              kind: 'directory',
              changeKind: 'untracked',
              staged: false,
              hasUnstaged: true,
              children: [
                {
                  path: 'newdir/subdir/file.txt',
                  name: 'file.txt',
                  kind: 'file',
	                  changeKind: 'untracked',
	                  staged: false,
	                  hasUnstaged: true,
	                  indexStatus: '?',
	                  workTreeStatus: '?',
	                  unstagedFacet: {
	                    status: '?',
	                    changeKind: 'untracked',
	                    stats: { additions: 0, deletions: 0 },
	                  },
	                  additions: 0,
	                  deletions: 0,
                },
              ],
            },
          ],
        },
      ]);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('reports separate staged and unstaged facets for the same file', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-mixed-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(path.join(projectPath, 'a.txt'), 'one\nstaged\n', 'utf-8');
      await runGitCommand(projectPath, ['add', 'a.txt']);
      await fs.writeFile(path.join(projectPath, 'a.txt'), 'one\nstaged\nunstaged\n', 'utf-8');

      const tree = await git.getChangesTree({ projectPath });
      const file = tree.root.find((node) => node.path === 'a.txt');

      expect(file.indexStatus).toBe('M');
      expect(file.workTreeStatus).toBe('M');
      expect(file.staged).toBe(true);
      expect(file.hasUnstaged).toBe(true);
      expect(file.stagedFacet).toMatchObject({ status: 'M', changeKind: 'modified' });
      expect(file.unstagedFacet).toMatchObject({ status: 'M', changeKind: 'modified' });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});

describe('getFileReviewData', () => {
  it('keeps staged and working deletion review modes separate', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-review-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(path.join(projectPath, 'a.txt'), 'one\nstaged\n', 'utf-8');
      await runGitCommand(projectPath, ['add', 'a.txt']);
      await fs.rm(path.join(projectPath, 'a.txt'));

      const staged = await git.getFileReviewData({ projectPath, file: 'a.txt', mode: 'staged', context: 3 });
      const working = await git.getFileReviewData({ projectPath, file: 'a.txt', mode: 'working', context: 3 });

	      expect(staged.mode).toBe('staged');
	      expect(staged.isBinary).toBe(false);
	      expect(staged.rows.some((row) => row.kind === 'add' && row.text === 'staged')).toBe(true);
	      expect(staged.rows.some((row) => row.kind === 'del')).toBe(false);
	      expect(staged.hunks.length).toBeGreaterThan(0);
	      expect('contentBefore' in staged).toBe(false);
	      expect('contentAfter' in staged).toBe(false);
	      expect('diffOps' in staged).toBe(false);

	      expect(working.mode).toBe('working');
	      expect(working.isBinary).toBe(false);
	      expect(working.rows.some((row) => row.kind === 'del' && row.text === 'staged')).toBe(true);
	      expect(working.rows.some((row) => row.kind === 'add')).toBe(false);
	      expect(working.hunks.length).toBeGreaterThan(0);
	      expect('contentBefore' in working).toBe(false);
	      expect('contentAfter' in working).toBe(false);
	      expect('diffOps' in working).toBe(false);
	    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});

describe('toHttpError', () => {
  const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

  it('maps INVALID_INPUT GitDomainError to 400', async () => {
    const err = new GitDomainError('INVALID_INPUT', 'Missing field');
    const response = git.toHttpError(err);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Missing field');
  });

  it('maps NOT_REPO GitDomainError to 400', async () => {
    const err = new GitDomainError('NOT_REPO', 'Not a repo');
    const response = git.toHttpError(err);
    expect(response.status).toBe(400);
  });

  it('maps AUTH_FAILED GitDomainError to 401', async () => {
    const err = new GitDomainError('AUTH_FAILED', 'Auth failed');
    const response = git.toHttpError(err);
    expect(response.status).toBe(401);
  });

  it('maps unknown GitDomainError codes to 500', async () => {
    const err = new GitDomainError('SOME_OTHER', 'Other error');
    const response = git.toHttpError(err);
    expect(response.status).toBe(500);
  });

  it('maps commit message timeout domain code to 504 + typed errorCode', async () => {
    const err = new GitDomainError('COMMIT_MESSAGE_TIMEOUT', 'Timed out');
    const response = git.toHttpError(err);
    expect(response.status).toBe(504);
    const body = await response.json();
    expect(body.error).toBe('Timed out');
    expect(body.errorCode).toBe('commit_message_timeout');
  });

  it('delegates non-GitDomainError to classifier', async () => {
    const err = new Error('random failure');
    const response = git.toHttpError(err);
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe('random failure');
  });

  it('includes details from classifier when available', async () => {
    const err = new Error('Could not resolve hostname github.com');
    const response = git.toHttpError(err);
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe('Could not reach the remote host.');
    expect(body.details).toBe('Verify network access.');
  });
});
