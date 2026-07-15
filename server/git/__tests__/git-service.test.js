import { describe, it, expect } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { GitDomainError } from '../git-types.js';
import { createGitService } from '../git-service.js';
import { generateCommitMessage } from '../commit-message.js';
import { collectCommitMessageDiffContext } from '../status.js';
import { runGitTraced } from '../run.js';
import { GIT_REVIEW_DOCUMENT_LIMITS } from '../types.js';

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

function findTreeNode(nodes, nodePath) {
  for (const node of nodes) {
    if (node.path === nodePath) return node;
    if (Array.isArray(node.children)) {
      const child = findTreeNode(node.children, nodePath);
      if (child) return child;
    }
  }
  return null;
}

async function expectSummaryAndBodyFingerprintsMatch(git, projectPath, { file = 'a.txt', mode = 'working' } = {}) {
  const snapshot = await git.getWorkbenchSnapshot({ projectPath, mode, context: 5 });
  expect(snapshot.status).toBe('ready');
  const summary = snapshot.reviewSummary.files.find((entry) => entry.path === file);
  expect(summary).toBeDefined();

  const body = (await git.getReviewFileBodies({
    projectPath,
    documentId: snapshot.reviewSummary.documentId,
    files: [file],
    mode,
    context: 5,
  })).files[file];

  expect(body).toBeDefined();
  expect(body.bodyFingerprint).toBe(summary.bodyFingerprint);
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
	      'commit', 'getBranches', 'getRefs', 'checkout', 'createBranch',
	      'getHistoryCommits', 'getCommitSnapshot', 'getCommitFileBodies',
	      'generateCommitMessageForFiles',
	      'getRemoteStatus', 'getRemotes', 'fetch', 'pull', 'push',
	      'discard', 'deleteUntracked', 'getWorkbenchSnapshot', 'getWorkbenchFingerprint',
	      'getQuickSummary',
	      'getReviewFileBodies', 'stageSelection', 'stageHunk',
	      'getWorktrees', 'getTargetCandidates', 'createWorktree', 'removeWorktree',
	      'commitIndex', 'stagePaths', 'revertCommit',
	      'getConflicts', 'getConflictDetails', 'acceptConflictSide', 'markConflictResolved',
	      'getStashes', 'createStash', 'applyStash', 'popStash', 'dropStash',
	      'getFileHistory', 'getBlame', 'getGraph', 'getCompare',
	      'toHttpError',
	    ];
	    for (const method of expectedMethods) {
	      expect(typeof git[method]).toBe('function');
	    }
	    expect(git.stageFile).toBeUndefined();
	  });
	});

describe('stage path operations', () => {
  it('stages and unstages multiple pathspecs in one service call', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-stage-paths-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(path.join(projectPath, 'remove.txt'), 'delete me\n', 'utf-8');
      await runGitCommand(projectPath, ['add', 'remove.txt']);
      await runGitCommand(projectPath, ['commit', '-m', 'add removable file']);

      await fs.writeFile(path.join(projectPath, 'a.txt'), 'changed\n', 'utf-8');
      await fs.rm(path.join(projectPath, 'remove.txt'));
      await fs.writeFile(path.join(projectPath, 'new.txt'), 'new file\n', 'utf-8');

      await git.stagePaths({
        projectPath,
        paths: ['a.txt', 'remove.txt', 'new.txt'],
        mode: 'stage',
      });

      const staged = await runGitCommand(projectPath, ['diff', '--cached', '--name-status']);
      expect(staged.stdout.trim().split('\n').sort()).toEqual([
        'A\tnew.txt',
        'D\tremove.txt',
        'M\ta.txt',
      ]);

      await git.stagePaths({
        projectPath,
        paths: ['a.txt', 'remove.txt', 'new.txt'],
        mode: 'unstage',
      });

      const unstaged = await runGitCommand(projectPath, ['diff', '--cached', '--name-only']);
      expect(unstaged.stdout.trim()).toBe('');
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});

describe('commit message generation', () => {
  it('builds the staged diff with one batched pathspec command for normal selections', async () => {
    const calls = [];
    const diffContext = await collectCommitMessageDiffContext(
      '/repo',
      ['src/a.ts', 'src/b.ts'],
      async (cwd, args, options) => {
        calls.push({ cwd, args, options });
        return { stdout: 'patch text' };
      },
    );

    expect(diffContext).toBe('patch text');
    expect(calls).toEqual([
      {
        cwd: '/repo',
        args: [
          'diff',
          '--cached',
          '--no-ext-diff',
          '--no-color',
          '-U10',
          '--',
          'src/a.ts',
          'src/b.ts',
        ],
        options: { disableOptionalLocks: true },
      },
    ]);
  });

  it('keeps up to eighty thousand diff characters in generated commit message prompts', async () => {
    let capturedPrompt = '';
    const marker = 'after-limit-marker';
    const diffContext = `${'a'.repeat(80_000)}${marker}`;

    await generateCommitMessage(
      ['a.txt'],
      diffContext,
      'claude',
      '/tmp',
      (prompt) => {
        capturedPrompt = prompt;
        return Promise.resolve('chore: stub');
      },
    );

    const diffStart = capturedPrompt.indexOf('Diff excerpt:\n') + 'Diff excerpt:\n'.length;
    const diffEnd = capturedPrompt.indexOf('\n\nReturn only the commit message now.', diffStart);
    const diffExcerpt = capturedPrompt.slice(diffStart, diffEnd);

    expect(diffExcerpt).toHaveLength(80_000);
    expect(diffExcerpt).not.toContain(marker);
  });

  it('returns the server-applied directory prefix with generated messages', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-commit-message-prefix-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await initRepoWithCommit(projectPath);
      await fs.mkdir(path.join(projectPath, 'feature', 'auth'), { recursive: true });
      await fs.writeFile(path.join(projectPath, 'feature', 'auth', 'a.txt'), 'a\n', 'utf-8');
      await fs.writeFile(path.join(projectPath, 'feature', 'auth', 'b.txt'), 'b\n', 'utf-8');
      await runGitCommand(projectPath, ['add', 'feature/auth/a.txt', 'feature/auth/b.txt']);

      const result = await git.generateCommitMessageForFiles({
        projectPath,
        files: ['feature/auth/a.txt', 'feature/auth/b.txt'],
        agentId: 'claude',
        useCommonDirPrefix: true,
      });

      expect(result).toEqual({
        message: 'feature/auth: chore: stub',
        directoryPrefix: 'feature/auth',
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('captures selected multi-file staged diffs from a real repository', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-commit-message-batched-'));
    let capturedPrompt = '';
    const git = createGitService({
      agents: {
        runSingleQuery: (prompt) => {
          capturedPrompt = prompt;
          return Promise.resolve('chore: stub');
        },
      },
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      await fs.mkdir(path.join(projectPath, 'feature'), { recursive: true });
      await fs.writeFile(path.join(projectPath, 'feature', 'a.txt'), 'alpha\n', 'utf-8');
      await fs.writeFile(path.join(projectPath, 'feature', 'name with space.txt'), 'space\n', 'utf-8');
      await fs.writeFile(path.join(projectPath, 'unselected.txt'), 'skip\n', 'utf-8');
      await runGitCommand(projectPath, [
        'add',
        'feature/a.txt',
        'feature/name with space.txt',
        'unselected.txt',
      ]);

      await git.generateCommitMessageForFiles({
        projectPath,
        files: ['feature/a.txt', 'feature/name with space.txt'],
        agentId: 'claude',
      });

      expect(capturedPrompt).toContain('diff --git a/feature/a.txt b/feature/a.txt');
      expect(capturedPrompt).toContain('+alpha');
      expect(capturedPrompt).toContain(
        'diff --git a/feature/name with space.txt b/feature/name with space.txt',
      );
      expect(capturedPrompt).toContain('+space');
      expect(capturedPrompt).not.toContain('unselected.txt');
      expect(capturedPrompt).not.toContain('+skip');
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('uses ten lines of hunk context for generated commit message prompts', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-commit-message-context-'));
    let capturedPrompt = '';
    const git = createGitService({
      agents: {
        runSingleQuery: (prompt) => {
          capturedPrompt = prompt;
          return Promise.resolve('chore: stub');
        },
      },
      classifyGitError: mockClassifyGitError,
    });

    try {
      await initRepoWithCommit(projectPath);
      const lines = Array.from({ length: 25 }, (_, index) => `line ${index + 1}`);
      await fs.writeFile(path.join(projectPath, 'a.txt'), `${lines.join('\n')}\n`, 'utf-8');
      await runGitCommand(projectPath, ['add', 'a.txt']);
      await runGitCommand(projectPath, ['commit', '-m', 'expand fixture']);

      lines[12] = 'line 13 changed';
      await fs.writeFile(path.join(projectPath, 'a.txt'), `${lines.join('\n')}\n`, 'utf-8');
      await runGitCommand(projectPath, ['add', 'a.txt']);

      await git.generateCommitMessageForFiles({
        projectPath,
        files: ['a.txt'],
        agentId: 'claude',
      });

      expect(capturedPrompt).toContain('@@ -3,21 +3,21 @@');
      expect(capturedPrompt).toContain('\n line 3\n');
      expect(capturedPrompt).toContain('-line 13\n');
      expect(capturedPrompt).toContain('+line 13 changed\n');
      expect(capturedPrompt).toContain('\n line 23\n');
      expect(capturedPrompt).not.toContain('\n line 2\n');
      expect(capturedPrompt).not.toContain('\n line 24\n');
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});

describe('commit history operations', () => {
  it('returns structured commit history and lazy commit body rows', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-history-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(path.join(projectPath, 'a.txt'), 'one\ntwo\n', 'utf-8');
      await runGitCommand(projectPath, ['commit', '-am', 'add second line']);

      const history = await git.getHistoryCommits({ projectPath, limit: 10, offset: 0 });

      expect(history.project).toBe(projectPath);
      expect(history.ref).toBe('HEAD');
      expect(history.commits).toHaveLength(2);
      expect(history.commits[0]).toMatchObject({
        author: 'Test User',
        authorEmail: 'test@example.com',
        subject: 'add second line',
      });
      expect(history.commits[0].parents).toHaveLength(1);

      const snapshot = await git.getCommitSnapshot({
        projectPath,
        commit: history.commits[0].hash,
        context: 5,
        bodyCandidateCount: 4,
      });

      expect(snapshot.status).toBe('ready');
      expect(snapshot.files[0]).toMatchObject({
        path: 'a.txt',
        status: 'modified',
        additions: 1,
        deletions: 0,
        bodyState: 'unloaded',
      });
      expect(snapshot.firstBodyCandidates).toEqual(['a.txt']);

      const bodies = await git.getCommitFileBodies({
        projectPath,
        documentId: snapshot.documentId,
        commit: snapshot.commit.hash,
        parent: snapshot.selectedParent,
        context: 5,
        files: ['a.txt'],
      });
      const body = bodies.files['a.txt'];

      expect(bodies.errors).toEqual({});
      expect(body.bodyFingerprint).toBe(snapshot.files[0].bodyFingerprint);
      expect(body.rows.some((row) => row.kind === 'add' && row.text === 'two')).toBe(true);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('renders root commits against the empty tree', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-history-root-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await initRepoWithCommit(projectPath);
      const { stdout } = await runGitCommand(projectPath, ['rev-list', '--max-parents=0', 'HEAD']);
      const rootCommit = stdout.trim();

      const snapshot = await git.getCommitSnapshot({ projectPath, commit: rootCommit, context: 5 });

      expect(snapshot.status).toBe('ready');
      expect(snapshot.selectedParent).toBeNull();
      expect(snapshot.files[0]).toMatchObject({
        path: 'a.txt',
        status: 'added',
        additions: 1,
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('exposes merge parents and rejects non-parent selections', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-history-merge-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ['checkout', '-b', 'side']);
      await fs.writeFile(path.join(projectPath, 'side.txt'), 'side\n', 'utf-8');
      await runGitCommand(projectPath, ['add', 'side.txt']);
      await runGitCommand(projectPath, ['commit', '-m', 'side change']);
      await runGitCommand(projectPath, ['checkout', 'master']);
      await fs.writeFile(path.join(projectPath, 'main.txt'), 'main\n', 'utf-8');
      await runGitCommand(projectPath, ['add', 'main.txt']);
      await runGitCommand(projectPath, ['commit', '-m', 'main change']);
      await runGitCommand(projectPath, ['merge', 'side', '-m', 'merge side']);

      const snapshot = await git.getCommitSnapshot({ projectPath, commit: 'HEAD', context: 5 });

      expect(snapshot.status).toBe('ready');
      expect(snapshot.parentOptions).toHaveLength(2);
      expect(snapshot.selectedParent).toBe(snapshot.parentOptions[0].hash);

      const secondParentSnapshot = await git.getCommitSnapshot({
        projectPath,
        commit: 'HEAD',
        parent: snapshot.parentOptions[1].hash,
        context: 5,
      });
      expect(secondParentSnapshot.status).toBe('ready');
      expect(secondParentSnapshot.selectedParent).toBe(snapshot.parentOptions[1].hash);

      await expect(
        git.getCommitSnapshot({ projectPath, commit: 'HEAD', parent: 'HEAD~3', context: 5 }),
      ).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        message: 'Requested parent is not a direct parent of the commit.',
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('preserves renamed paths in commit summaries', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-history-rename-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ['mv', 'a.txt', 'renamed file.txt']);
      await runGitCommand(projectPath, ['commit', '-m', 'rename file']);

      const snapshot = await git.getCommitSnapshot({ projectPath, commit: 'HEAD', context: 5 });

      expect(snapshot.status).toBe('ready');
      expect(snapshot.files).toContainEqual(
        expect.objectContaining({
          path: 'renamed file.txt',
          originalPath: 'a.txt',
          status: 'renamed',
          additions: 0,
        }),
      );
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});

describe('commit revert operations', () => {
  it('reverts a selected non-HEAD commit by hash', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-revert-commit-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(path.join(projectPath, 'b.txt'), 'two\n', 'utf-8');
      await runGitCommand(projectPath, ['add', 'b.txt']);
      await runGitCommand(projectPath, ['commit', '-m', 'add b']);
      const { stdout: commitToRevert } = await runGitCommand(projectPath, ['rev-parse', 'HEAD']);

      await fs.writeFile(path.join(projectPath, 'c.txt'), 'three\n', 'utf-8');
      await runGitCommand(projectPath, ['add', 'c.txt']);
      await runGitCommand(projectPath, ['commit', '-m', 'add c']);

      const result = await git.revertCommit({
        projectPath,
        commit: commitToRevert.trim(),
      });

      expect(result.success).toBe(true);
      await expect(fs.access(path.join(projectPath, 'b.txt'))).rejects.toThrow();
      await fs.access(path.join(projectPath, 'c.txt'));
      const { stdout: subject } = await runGitCommand(projectPath, ['log', '-1', '--pretty=%s']);
      expect(subject.trim()).toBe('Revert "add b"');
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
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

describe('worktree listing metadata', () => {
  it('reports root mtimes and keeps missing worktrees available to target discovery', async () => {
    const projectPath = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-worktree-times-')),
    );
    const linkedPath = `${projectPath}-feature`;
    const missingPath = `${projectPath}-missing`;
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ['worktree', 'add', '-b', 'feature', linkedPath]);
      await runGitCommand(projectPath, ['worktree', 'add', '-b', 'missing', missingPath]);

      const modifiedAt = new Date('2026-07-15T10:00:00.000Z');
      await fs.utimes(linkedPath, modifiedAt, modifiedAt);
      await fs.rm(missingPath, { recursive: true, force: true });

      const { worktrees } = await git.getWorktrees({ projectPath });
      expect(worktrees.map((worktree) => worktree.path)).toEqual([
        projectPath,
        linkedPath,
        missingPath,
      ]);
      expect(worktrees.find((worktree) => worktree.path === linkedPath)?.lastModifiedAt).toBe(
        modifiedAt.toISOString(),
      );
      expect(worktrees.find((worktree) => worktree.path === missingPath)).toMatchObject({
        isPathMissing: true,
        lastModifiedAt: null,
      });

      await fs.rm(linkedPath, { recursive: true, force: true });
      await fs.writeFile(linkedPath, 'not a directory');
      const { worktrees: worktreesWithFile } = await git.getWorktrees({ projectPath });
      expect(worktreesWithFile.find((worktree) => worktree.path === linkedPath)).toMatchObject({
        isPathMissing: true,
        lastModifiedAt: null,
      });

      const { targets } = await git.getTargetCandidates({ projectPath });
      expect(targets.find((target) => target.worktreePath === missingPath)).toMatchObject({
        source: 'worktree',
        isMissing: true,
      });
    } finally {
      await fs.rm(linkedPath, { recursive: true, force: true });
      await fs.rm(missingPath, { recursive: true, force: true });
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});

describe('getQuickSummary', () => {
  it('returns counts for staged, unstaged, and untracked files', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-quick-summary-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(path.join(projectPath, 'a.txt'), 'one\ntwo\n', 'utf-8');
      await fs.writeFile(path.join(projectPath, 'b.txt'), 'new\nfile\n', 'utf-8');
      await runGitCommand(projectPath, ['add', 'b.txt']);
      await fs.writeFile(path.join(projectPath, 'c.txt'), 'loose\nline\n', 'utf-8');

      const summary = await git.getQuickSummary({ projectPath });

      expect(summary).toMatchObject({
        status: 'ready',
        project: projectPath,
        hasCommits: true,
        changedFiles: 3,
        trackedChangedFiles: 2,
        untrackedFiles: 1,
        stagedFiles: 1,
        unstagedFiles: 1,
        additions: 3,
        deletions: 0,
        fingerprintVersion: 1,
      });
      expect('untrackedAdditions' in summary).toBe(false);
      expect('untrackedAdditionsCapped' in summary).toBe(false);
      expect(summary.branch).toBeTruthy();
      expect(summary.fingerprint).toMatch(/^v1:/);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('returns clean counts for an unchanged repository', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-quick-clean-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await initRepoWithCommit(projectPath);

      const summary = await git.getQuickSummary({ projectPath });

      expect(summary).toMatchObject({
        status: 'ready',
        changedFiles: 0,
        trackedChangedFiles: 0,
        untrackedFiles: 0,
        stagedFiles: 0,
        unstagedFiles: 0,
        additions: 0,
        deletions: 0,
        hasCommits: true,
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('returns ready summary for a repository with no commits', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-quick-unborn-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await runGitCommand(projectPath, ['init']);

      const summary = await git.getQuickSummary({ projectPath });

      expect(summary).toMatchObject({
        status: 'ready',
        hasCommits: false,
        changedFiles: 0,
        fingerprintVersion: 1,
      });
      expect(summary.branch).toBeTruthy();
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('returns typed non-repository response', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-quick-not-repo-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      const summary = await git.getQuickSummary({ projectPath });

      expect(summary).toMatchObject({
        status: 'not-git-repository',
        project: projectPath,
        fingerprintVersion: 1,
        fingerprint: null,
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('does not count untracked file lines', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-quick-untracked-count-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await initRepoWithCommit(projectPath);
      for (let index = 0; index < 33; index += 1) {
        await fs.writeFile(path.join(projectPath, `untracked-${index}.txt`), 'line\n', 'utf-8');
      }

      const summary = await git.getQuickSummary({ projectPath });

      expect(summary).toMatchObject({
        status: 'ready',
        untrackedFiles: 33,
      });
      expect('untrackedAdditions' in summary).toBe(false);
      expect('untrackedAdditionsCapped' in summary).toBe(false);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});

describe('getWorkbenchSnapshot', () => {
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

  it('returns tree and review summary from one loaded snapshot', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-snapshot-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(path.join(projectPath, 'a.txt'), 'one\ntwo\n', 'utf-8');
      const trace = [];
      const snapshot = await git.getWorkbenchSnapshot({ projectPath, mode: 'working', context: 5, trace });

      expect(snapshot.status).toBe('ready');
      expect(snapshot.tree.statsState).toBe('loaded');
      expect(trace.some((entry) => entry.args.includes('--numstat'))).toBe(true);
      expect(snapshot.tree.root[0]).toMatchObject({
        path: 'a.txt',
        additions: 1,
        deletions: 0,
      });
      expect(snapshot.reviewSummary.files[0]).toMatchObject({
        path: 'a.txt',
        additions: 1,
        deletions: 0,
        bodyState: 'unloaded',
      });
      expect(snapshot.selectedFile).toBe('a.txt');
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('aggregates directory stats from each changed file entry', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-tree-dir-stats-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await initRepoWithCommit(projectPath);
      await fs.mkdir(path.join(projectPath, 'src', 'nested'), { recursive: true });
      await fs.writeFile(path.join(projectPath, 'src', 'nested', 'large.txt'), 'base\n', 'utf-8');
      await fs.writeFile(path.join(projectPath, 'src', 'nested', 'small.txt'), 'base\n', 'utf-8');
      await runGitCommand(projectPath, ['add', 'src/nested/large.txt', 'src/nested/small.txt']);
      await runGitCommand(projectPath, ['commit', '-m', 'add nested files']);

      const largeLines = Array.from({ length: 75 }, (_, index) => `large ${index + 1}`);
      await fs.writeFile(
        path.join(projectPath, 'src', 'nested', 'large.txt'),
        `base\n${largeLines.join('\n')}\n`,
        'utf-8',
      );
      await fs.writeFile(path.join(projectPath, 'src', 'nested', 'small.txt'), 'base\nsmall 1\n', 'utf-8');

      const snapshot = await git.getWorkbenchSnapshot({ projectPath, mode: 'working', context: 5 });

      expect(snapshot.status).toBe('ready');
      expect(findTreeNode(snapshot.tree.root, 'src')).toMatchObject({
        additions: 76,
        deletions: 0,
      });
      expect(findTreeNode(snapshot.tree.root, 'src/nested')).toMatchObject({
        additions: 76,
        deletions: 0,
      });
      expect(findTreeNode(snapshot.tree.root, 'src/nested/large.txt')).toMatchObject({
        additions: 75,
        deletions: 0,
      });
      expect(findTreeNode(snapshot.tree.root, 'src/nested/small.txt')).toMatchObject({
        additions: 1,
        deletions: 0,
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('returns typed non-repository snapshots', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-not-repo-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      const snapshot = await git.getWorkbenchSnapshot({ projectPath, mode: 'working', context: 5 });

      expect(snapshot).toMatchObject({
        status: 'not-git-repository',
        project: projectPath,
        target: null,
        tree: null,
        reviewSummary: null,
        selectedFile: null,
        firstBodyCandidates: [],
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('loads numstat for paths containing tabs', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-tree-tab-path-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });
    const fileName = 'a\tb.txt';

    try {
      await runGitCommand(projectPath, ['init']);
      await runGitCommand(projectPath, ['config', 'user.email', 'test@example.com']);
      await runGitCommand(projectPath, ['config', 'user.name', 'Test User']);
      await fs.writeFile(path.join(projectPath, fileName), 'one\n', 'utf-8');
      await runGitCommand(projectPath, ['add', fileName]);
      await runGitCommand(projectPath, ['commit', '-m', 'initial']);
      await fs.writeFile(path.join(projectPath, fileName), 'one\ntwo\n', 'utf-8');

      const snapshot = await git.getWorkbenchSnapshot({ projectPath, mode: 'working', context: 5 });

      expect(snapshot.status).toBe('ready');
      expect(snapshot.tree.root).toHaveLength(1);
      expect(snapshot.tree.root[0]).toMatchObject({
        path: fileName,
        additions: 1,
        deletions: 0,
      });
      expect(snapshot.reviewSummary.files[0].path).toBe(fileName);
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

      const snapshot = await git.getWorkbenchSnapshot({ projectPath, mode: 'working', context: 5 });
      expect(snapshot.status).toBe('ready');
      expect(snapshot.tree.root).toMatchObject([
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

      const snapshot = await git.getWorkbenchSnapshot({ projectPath, mode: 'working', context: 5 });
      expect(snapshot.status).toBe('ready');
      const file = snapshot.tree.root.find((node) => node.path === 'a.txt');

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

  it('keeps staged text summaries independent from later binary worktree edits', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-staged-text-worktree-binary-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(path.join(projectPath, 'a.txt'), 'one\nstaged text\n', 'utf-8');
      await runGitCommand(projectPath, ['add', 'a.txt']);
      await fs.writeFile(path.join(projectPath, 'a.txt'), Buffer.from([0, 1, 2, 3, 4, 5]));

      const snapshot = await git.getWorkbenchSnapshot({ projectPath, mode: 'staged', context: 5 });
      expect(snapshot.status).toBe('ready');
      const summary = snapshot.reviewSummary.files.find((file) => file.path === 'a.txt');
      expect(summary.isBinary).toBe(false);
      expect(summary.bodyState).toBe('unloaded');

      const body = (await git.getReviewFileBodies({
        projectPath,
        documentId: snapshot.reviewSummary.documentId,
        files: ['a.txt'],
        mode: 'staged',
        context: 5,
      })).files['a.txt'];
      expect(body.bodyState).toBe('loaded');
      expect(body.isBinary).toBe(false);
      expect(body.rows.some((row) => row.kind === 'add' && row.text === 'staged text')).toBe(true);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('uses body-compatible fingerprints for common review states', async () => {
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });
    const cases = [
      {
        name: 'modified tracked path with spaces',
        mode: 'working',
        file: 'a b.txt',
        mutate: async (projectPath) => {
          await fs.writeFile(path.join(projectPath, 'a b.txt'), 'base\n', 'utf-8');
          await runGitCommand(projectPath, ['add', 'a b.txt']);
          await runGitCommand(projectPath, ['commit', '-m', 'add spaced path']);
          await fs.writeFile(path.join(projectPath, 'a b.txt'), 'base\nchanged\n', 'utf-8');
        },
      },
      {
        name: 'untracked file',
        mode: 'working',
        file: 'new file.txt',
        mutate: async (projectPath) => {
          await fs.writeFile(path.join(projectPath, 'new file.txt'), 'new\n', 'utf-8');
        },
      },
      {
        name: 'working deletion',
        mode: 'working',
        file: 'a.txt',
        mutate: async (projectPath) => {
          await fs.rm(path.join(projectPath, 'a.txt'));
        },
      },
      {
        name: 'staged modification',
        mode: 'staged',
        file: 'a.txt',
        mutate: async (projectPath) => {
          await fs.writeFile(path.join(projectPath, 'a.txt'), 'one\nstaged\n', 'utf-8');
          await runGitCommand(projectPath, ['add', 'a.txt']);
        },
      },
      {
        name: 'staged deletion',
        mode: 'staged',
        file: 'a.txt',
        mutate: async (projectPath) => {
          await runGitCommand(projectPath, ['rm', 'a.txt']);
        },
      },
    ];

    for (const testCase of cases) {
      const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), `garcon-git-fingerprint-${testCase.name.replaceAll(' ', '-')}-`));
      try {
        await initRepoWithCommit(projectPath);
        await testCase.mutate(projectPath);
        await expectSummaryAndBodyFingerprintsMatch(git, projectPath, {
          file: testCase.file,
          mode: testCase.mode,
        });
      } finally {
        await fs.rm(projectPath, { recursive: true, force: true });
      }
    }
  });
});

describe('getWorkbenchFingerprint', () => {
  it('matches the ready snapshot baseline for the same workbench state', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-freshness-baseline-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(path.join(projectPath, 'a.txt'), 'one\nchanged\n', 'utf-8');

      const snapshot = await git.getWorkbenchSnapshot({ projectPath, mode: 'working', context: 5 });
      const current = await git.getWorkbenchFingerprint({ projectPath });

      expect(snapshot.status).toBe('ready');
      expect(current.status).toBe('ready');
      expect(snapshot.workbenchFingerprint).toBe(current.fingerprint);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('changes for same-status edits, untracked edits, staged changes, and HEAD changes', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-freshness-changes-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await initRepoWithCommit(projectPath);
      const base = await git.getWorkbenchFingerprint({ projectPath });
      expect(base.status).toBe('ready');

      await fs.writeFile(path.join(projectPath, 'a.txt'), 'one\nfirst modified state\n', 'utf-8');
      const modified = await git.getWorkbenchFingerprint({ projectPath });
      expect(modified.status).toBe('ready');
      expect(modified.fingerprint).not.toBe(base.fingerprint);

      await fs.writeFile(path.join(projectPath, 'a.txt'), 'one\nsecond modified state with more bytes\n', 'utf-8');
      const sameStatusModified = await git.getWorkbenchFingerprint({ projectPath });
      expect(sameStatusModified.status).toBe('ready');
      expect(sameStatusModified.fingerprint).not.toBe(modified.fingerprint);

      await fs.writeFile(path.join(projectPath, 'space and\ttab.txt'), 'new\n', 'utf-8');
      const untracked = await git.getWorkbenchFingerprint({ projectPath });
      expect(untracked.status).toBe('ready');
      expect(untracked.fingerprint).not.toBe(sameStatusModified.fingerprint);

      await fs.writeFile(path.join(projectPath, 'space and\ttab.txt'), 'new\nchanged\n', 'utf-8');
      const editedUntracked = await git.getWorkbenchFingerprint({ projectPath });
      expect(editedUntracked.status).toBe('ready');
      expect(editedUntracked.fingerprint).not.toBe(untracked.fingerprint);

      await runGitCommand(projectPath, ['add', 'a.txt']);
      const staged = await git.getWorkbenchFingerprint({ projectPath });
      expect(staged.status).toBe('ready');
      expect(staged.fingerprint).not.toBe(editedUntracked.fingerprint);

      await runGitCommand(projectPath, ['commit', '-m', 'update tracked file']);
      const committed = await git.getWorkbenchFingerprint({ projectPath });
      expect(committed.status).toBe('ready');
      expect(committed.fingerprint).not.toBe(staged.fingerprint);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('returns a typed non-repository fingerprint response', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-freshness-not-repo-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      const result = await git.getWorkbenchFingerprint({ projectPath });
      expect(result).toMatchObject({
        status: 'not-git-repository',
        project: projectPath,
        fingerprint: null,
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});

describe('review document file bodies', () => {
  it('does not create a trailing context row from the terminal patch newline', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-rendered-row-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(path.join(projectPath, 'a.txt'), 'one\ntwo\n', 'utf-8');

      const result = await git.getReviewFileBodies({
        projectPath,
        documentId: 'doc',
        files: ['a.txt'],
        mode: 'working',
        context: 3,
      });
      const review = result.files['a.txt'];
      const lastRow = review.rows[review.rows.length - 1];

      expect(lastRow).toMatchObject({ kind: 'add', text: 'two' });
      expect(review.rows).not.toContainEqual(
        expect.objectContaining({ kind: 'context', text: '', beforeLine: 2, afterLine: 3 }),
      );
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('classifies deleted binary files as binary review data', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-binary-delete-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(path.join(projectPath, 'blob.bin'), Buffer.from([0, 1, 2, 3, 255, 0, 10]));
      await runGitCommand(projectPath, ['add', 'blob.bin']);
      await runGitCommand(projectPath, ['commit', '-m', 'add binary']);
      await fs.rm(path.join(projectPath, 'blob.bin'));

      const result = await git.getReviewFileBodies({
        projectPath,
        documentId: 'doc',
        files: ['blob.bin'],
        mode: 'working',
        context: 3,
      });
      const review = result.files['blob.bin'];

      expect(review.bodyState).toBe('binary');
      expect(review.isBinary).toBe(true);
      expect(review.limitReason).toBe('binary');
      expect(review.rows).toEqual([]);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

	  it('parses batch review data for paths with spaces', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-batch-spaces-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(path.join(projectPath, 'a b.txt'), 'old\n', 'utf-8');
      await runGitCommand(projectPath, ['add', 'a b.txt']);
      await runGitCommand(projectPath, ['commit', '-m', 'add spaced path']);
      await fs.writeFile(path.join(projectPath, 'a b.txt'), 'new\n', 'utf-8');

      const batch = await git.getReviewFileBodies({
        projectPath,
        documentId: 'doc',
        files: ['a b.txt'],
        mode: 'working',
        context: 3,
      });
      const review = batch.files['a b.txt'];

      expect(batch.errors).toEqual({});
      expect(review.rows.some((row) => row.kind === 'del' && row.text === 'old')).toBe(true);
      expect(review.rows.some((row) => row.kind === 'add' && row.text === 'new')).toBe(true);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
	  });

	  it('returns bounded preview rows for long untracked text files', async () => {
	    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-preview-long-'));
	    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

	    try {
	      await initRepoWithCommit(projectPath);
      await fs.writeFile(
	        path.join(projectPath, 'long.md'),
	        Array.from({ length: 2_500 }, (_, index) =>
	          `line ${index + 1}`,
	        ).join('\n') + '\n',
	        'utf-8',
	      );

	      const batch = await git.getReviewFileBodies({
	        projectPath,
	        documentId: 'doc',
	        files: ['long.md'],
	        mode: 'working',
	        context: 3,
	      });
	      const review = batch.files['long.md'];

	      expect(batch.errors).toEqual({});
	      expect(review.bodyState).toBe('loaded');
	      expect(review.rows.length).toBeGreaterThan(2_000);
	      expect(review.rows.some((row) => row.kind === 'add' && row.text === 'line 1')).toBe(true);
	    } finally {
	      await fs.rm(projectPath, { recursive: true, force: true });
	    }
	  });

	  it('keeps staged and working deletion review modes separate', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-review-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(path.join(projectPath, 'a.txt'), 'one\nstaged\n', 'utf-8');
      await runGitCommand(projectPath, ['add', 'a.txt']);
      await fs.rm(path.join(projectPath, 'a.txt'));

      const staged = (await git.getReviewFileBodies({
        projectPath,
        documentId: 'doc',
        files: ['a.txt'],
        mode: 'staged',
        context: 3,
      })).files['a.txt'];
      const working = (await git.getReviewFileBodies({
        projectPath,
        documentId: 'doc',
        files: ['a.txt'],
        mode: 'working',
        context: 3,
      })).files['a.txt'];

	      expect(staged.bodyState).toBe('loaded');
	      expect(staged.isBinary).toBe(false);
	      expect(staged.rows.some((row) => row.kind === 'add' && row.text === 'staged')).toBe(true);
	      expect(staged.rows.some((row) => row.kind === 'del')).toBe(false);
	      expect(staged.hunks.length).toBeGreaterThan(0);

	      expect(working.bodyState).toBe('loaded');
	      expect(working.isBinary).toBe(false);
	      expect(working.rows.some((row) => row.kind === 'del' && row.text === 'staged')).toBe(true);
	      expect(working.rows.some((row) => row.kind === 'add')).toBe(false);
	      expect(working.hunks.length).toBeGreaterThan(0);
	    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('returns too-large for files over the hard row limit', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-hard-limit-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await initRepoWithCommit(projectPath);
      await fs.writeFile(
        path.join(projectPath, 'huge.md'),
        Array.from({ length: GIT_REVIEW_DOCUMENT_LIMITS.maxFileRows + 1 }, (_, index) =>
          `line ${index + 1}`,
        ).join('\n') + '\n',
        'utf-8',
      );

      const batch = await git.getReviewFileBodies({
        projectPath,
        documentId: 'doc',
        files: ['huge.md'],
        mode: 'working',
        context: 3,
      });
      const review = batch.files['huge.md'];

      expect(review.bodyState).toBe('too-large');
      expect(review.limitReason).toBe('file-too-many-rows');
      expect(review.rows).toEqual([]);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});

describe('git ref checkout and branch creation', () => {
  it('lists local branches by default and finds remote branches and tags by search', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-refs-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ['branch', '-M', 'main']);
      await runGitCommand(projectPath, ['tag', 'v1.0.0']);
      const { stdout: head } = await runGitCommand(projectPath, ['rev-parse', 'HEAD']);
      await runGitCommand(projectPath, ['update-ref', 'refs/remotes/origin/main', head.trim()]);
      await runGitCommand(projectPath, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);

      const { refs } = await git.getRefs({ projectPath });

      expect(refs).toContainEqual({
        name: 'main',
        ref: 'refs/heads/main',
        kind: 'local-branch',
        isCurrent: true,
      });
      expect(refs.some((ref) => ref.kind === 'remote-branch')).toBe(false);
      expect(refs.some((ref) => ref.kind === 'tag')).toBe(false);

      const { refs: remoteRefs } = await git.getRefs({ projectPath, query: 'origin/main' });
      expect(remoteRefs).toContainEqual({
        name: 'origin/main',
        ref: 'refs/remotes/origin/main',
        kind: 'remote-branch',
      });
      expect(remoteRefs.some((ref) => ref.name === 'origin/HEAD')).toBe(false);

      const { refs: tagRefs } = await git.getRefs({ projectPath, query: 'v1.0.0' });
      expect(tagRefs).toContainEqual({
        name: 'v1.0.0',
        ref: 'refs/tags/v1.0.0',
        kind: 'tag',
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('returns bounded ref search results', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-ref-search-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ['branch', '-M', 'main']);
      const { stdout: head } = await runGitCommand(projectPath, ['rev-parse', 'HEAD']);
      await runGitCommand(projectPath, ['update-ref', 'refs/remotes/origin/main', head.trim()]);
      await runGitCommand(projectPath, ['update-ref', 'refs/remotes/upstream/main', head.trim()]);

      const { refs } = await git.getRefs({ projectPath, query: 'main', limit: 1 });

      expect(refs).toHaveLength(1);
      expect(refs[0].name).toContain('main');
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('keeps local branch checkout attached', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-local-checkout-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ['branch', '-M', 'main']);
      await runGitCommand(projectPath, ['checkout', '-b', 'feature']);
      await runGitCommand(projectPath, ['checkout', 'main']);

      await git.checkout({ projectPath, ref: 'refs/heads/feature' });
      const { stdout } = await runGitCommand(projectPath, ['branch', '--show-current']);

      expect(stdout.trim()).toBe('feature');
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('checks out remote refs without creating a local branch', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-remote-checkout-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ['branch', '-M', 'main']);
      const { stdout: head } = await runGitCommand(projectPath, ['rev-parse', 'HEAD']);
      await runGitCommand(projectPath, ['update-ref', 'refs/remotes/origin/main', head.trim()]);

      await git.checkout({ projectPath, ref: 'refs/remotes/origin/main' });
      const { stdout: branch } = await runGitCommand(projectPath, ['branch', '--show-current']);
      const { stdout: localMain } = await runGitCommand(projectPath, ['rev-parse', '--verify', 'refs/heads/main']);

      expect(branch.trim()).toBe('');
      expect(localMain.trim()).toBe(head.trim());
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('uses the selected ref kind when a tag collides with a local branch name', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-tag-collision-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ['branch', '-M', 'main']);
      await runGitCommand(projectPath, ['branch', 'release']);
      const { stdout: branchCommit } = await runGitCommand(projectPath, ['rev-parse', 'refs/heads/release']);
      await fs.writeFile(path.join(projectPath, 'a.txt'), 'one\ntwo\n', 'utf-8');
      await runGitCommand(projectPath, ['commit', '-am', 'tag target']);
      await runGitCommand(projectPath, ['tag', 'release']);
      const { stdout: tagCommit } = await runGitCommand(projectPath, ['rev-parse', 'refs/tags/release']);

      await git.checkout({ projectPath, ref: 'refs/tags/release', refKind: 'tag' });
      const { stdout: branch } = await runGitCommand(projectPath, ['branch', '--show-current']);
      const { stdout: head } = await runGitCommand(projectPath, ['rev-parse', 'HEAD']);

      expect(branch.trim()).toBe('');
      expect(head.trim()).toBe(tagCommit.trim());
      expect(head.trim()).not.toBe(branchCommit.trim());
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('creates a branch from a selected base ref', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-branch-base-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ['branch', '-M', 'main']);
      await runGitCommand(projectPath, ['checkout', '-b', 'remote-source']);
      await fs.writeFile(path.join(projectPath, 'a.txt'), 'one\ntwo\n', 'utf-8');
      await runGitCommand(projectPath, ['commit', '-am', 'remote edit']);
      const { stdout: remoteCommit } = await runGitCommand(projectPath, ['rev-parse', 'HEAD']);
      await runGitCommand(projectPath, ['update-ref', 'refs/remotes/origin/main', remoteCommit.trim()]);
      await runGitCommand(projectPath, ['checkout', 'main']);

      await git.createBranch({
        projectPath,
        branch: 'feature/from-origin',
        baseRef: 'refs/remotes/origin/main',
      });
      const { stdout: branch } = await runGitCommand(projectPath, ['branch', '--show-current']);
      const { stdout: head } = await runGitCommand(projectPath, ['rev-parse', 'HEAD']);

      expect(branch.trim()).toBe('feature/from-origin');
      expect(head.trim()).toBe(remoteCommit.trim());
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});

describe('porcelain ref validation', () => {
  it('rejects option-like checkout refs', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-ref-checkout-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await initRepoWithCommit(projectPath);

      await expect(
        git.checkout({ projectPath, ref: '-HEAD' }),
      ).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        message: 'Invalid checkout ref.',
      });
      await expect(
        git.checkout({ projectPath, ref: '.' }),
      ).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        message: 'Invalid checkout ref.',
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('rejects invalid branch creation names and base refs', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-ref-create-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await initRepoWithCommit(projectPath);

      await expect(
        git.createBranch({ projectPath, branch: '-bad' }),
      ).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        message: 'Invalid branch name.',
      });
      await expect(
        git.createBranch({ projectPath, branch: '.' }),
      ).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        message: 'Invalid branch name.',
      });
      await expect(
        git.createBranch({ projectPath, branch: 'feature/good', baseRef: 'missing-ref' }),
      ).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        message: 'Invalid base ref.',
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('rejects invalid worktree branch names and base refs', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-ref-worktree-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await initRepoWithCommit(projectPath);

      await expect(
        git.createWorktree({
          projectPath,
          worktreePath: path.join(os.tmpdir(), 'garcon-worktree-bad-branch'),
          branch: '--bad',
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        message: 'Invalid branch name.',
      });
      await expect(
        git.createWorktree({
          projectPath,
          worktreePath: path.join(os.tmpdir(), 'garcon-worktree-bad-base'),
          branch: 'feature/good',
          baseRef: '-x',
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        message: 'Invalid base ref.',
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('rejects invalid push remotes and remote branches', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-ref-push-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await initRepoWithCommit(projectPath);

      await expect(
        git.push({ projectPath, remote: '--force' }),
      ).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        message: 'Invalid remote.',
      });
      await expect(
        git.push({ projectPath, remoteBranch: '-x' }),
      ).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        message: 'Invalid remote branch name.',
      });
      await runGitCommand(projectPath, ['branch', '-M', 'feature']);
      await expect(
        git.push({ projectPath, remoteBranch: 'main' }),
      ).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        message: 'Remote branch must match the current local branch.',
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('rejects option-like blame refs', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-ref-blame-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await initRepoWithCommit(projectPath);

      await expect(
        git.getBlame({ projectPath, file: 'a.txt', ref: '-HEAD' }),
      ).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        message: 'Invalid blame ref.',
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('verifies compare refs before running the compare diff', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-ref-compare-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await initRepoWithCommit(projectPath);

      await expect(
        git.getCompare({ projectPath, base: 'missing-ref', head: 'HEAD' }),
      ).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        message: 'Invalid base ref.',
      });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});

describe('porcelain conflict and compare robustness', () => {
  it('returns bounded conflict details for large conflicted files', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-conflict-limit-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });

    try {
      await initRepoWithCommit(projectPath);
      await runGitCommand(projectPath, ['checkout', '-b', 'side']);
      await fs.writeFile(path.join(projectPath, 'a.txt'), `one\n${'side\n'.repeat(70_000)}`, 'utf-8');
      await runGitCommand(projectPath, ['commit', '-am', 'side edit']);
      await runGitCommand(projectPath, ['checkout', 'master']);
      await fs.writeFile(path.join(projectPath, 'a.txt'), `one\n${'main\n'.repeat(70_000)}`, 'utf-8');
      await runGitCommand(projectPath, ['commit', '-am', 'main edit']);
      try {
        await runGitCommand(projectPath, ['merge', 'side']);
      } catch {
        // Expected merge conflict.
      }

      const { conflicts } = await git.getConflicts({ projectPath });
      const conflict = conflicts.find((entry) => entry.path === 'a.txt');
      const details = await git.getConflictDetails({ projectPath, file: 'a.txt' });

      expect(conflict).toMatchObject({
        status: 'UU',
        baseAvailable: true,
        oursAvailable: true,
        theirsAvailable: true,
      });
      expect(details.truncated).toBe(true);
      expect(details.ours).toMatchObject({
        content: null,
        truncated: true,
        limitReason: 'content-too-large',
      });
      expect(details.theirs).toMatchObject({
        content: null,
        truncated: true,
        limitReason: 'content-too-large',
      });
      expect(details.working.byteLength).toBeGreaterThan(0);
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('parses compare output for paths containing tabs', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-git-compare-z-'));
    const git = createGitService({ agents: mockAgents, classifyGitError: mockClassifyGitError });
    const tabbedPath = 'a\tb.txt';
    const renamedPath = 'c\td.txt';

    try {
      await runGitCommand(projectPath, ['init']);
      await runGitCommand(projectPath, ['config', 'user.email', 'test@example.com']);
      await runGitCommand(projectPath, ['config', 'user.name', 'Test User']);
      await fs.writeFile(path.join(projectPath, tabbedPath), 'one\n', 'utf-8');
      await runGitCommand(projectPath, ['add', tabbedPath]);
      await runGitCommand(projectPath, ['commit', '-m', 'initial']);
      await runGitCommand(projectPath, ['checkout', '-b', 'next']);
      await runGitCommand(projectPath, ['mv', tabbedPath, renamedPath]);
      await fs.writeFile(path.join(projectPath, renamedPath), 'one\ntwo\n', 'utf-8');
      await runGitCommand(projectPath, ['commit', '-am', 'rename tabbed path']);

      const compare = await git.getCompare({ projectPath, base: 'master', head: 'next' });

      expect(compare.files).toContainEqual(
        expect.objectContaining({
          status: expect.stringMatching(/^R/),
          originalPath: tabbedPath,
          path: renamedPath,
          additions: 1,
          deletions: 0,
        }),
      );
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
