import { describe, it, expect } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { GitDomainError } from '../git-types.js';
import { createGitService } from '../git-service.js';

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
      'getFileReviewDataBatch', 'getChangesTree', 'stageSelection', 'stageHunk',
      'getWorktrees', 'getTargetCandidates', 'createWorktree', 'removeWorktree',
      'commitIndex', 'stageFile', 'revertLastCommit', 'toHttpError',
    ];
    for (const method of expectedMethods) {
      expect(typeof git[method]).toBe('function');
    }
  });
});

describe('getChangesTree', () => {
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

      expect(staged.contentBefore).toContain('one');
      expect(staged.contentAfter).toContain('staged');
      expect(staged.diffOps.some((op) => op.type === 'insert')).toBe(true);
      expect(working.contentBefore).toContain('staged');
      expect(working.contentAfter).toBeNull();
      expect(working.diffOps.some((op) => op.type === 'delete')).toBe(true);
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
