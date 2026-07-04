import { promises as fs } from 'fs';
import { GitDomainError } from './git-types.js';
import { generateCommitMessage } from './commit-message.js';
import { createLogger } from '../lib/log.js';
import { errorMessage } from '../lib/errors.js';
import { applyDirPrefix, computeCommonDirPrefix } from './commit-prefix.ts';
import { chunkGitPathspecs } from './pathspecs.js';
import type {
  BranchOptions,
  CheckoutOptions,
  CommitIndexOptions,
  CommitMessageGenerationResult,
  CommitMessageFileOptions,
  CommitOptions,
  FileOptions,
  GitAgentRunner,
  GitRefOption,
  GitRefsResponse,
  GitRefsOptions,
  ProjectOptions,
  PushOptions,
  RemoteInfo,
  RevertCommitOptions,
  RunSingleQueryOptions,
  StageFileOptions,
} from './types.js';
import {
  assertGitRepository,
  readOnlyGitOptions,
  resolvePathWithinProject,
  runGit,
  stripDiffHeaders,
} from './run.js';
import {
  assertExistingCommitRef,
  assertSafeBranchName,
  assertSafeRemoteName,
} from './ref-validation.js';

const logger = createLogger('git:status');
const COMMIT_MESSAGE_DIFF_CONTEXT_LINES = 10;
const DEFAULT_REF_RESULT_LIMIT = 200;
const MAX_REF_RESULT_LIMIT = 500;
type CommitMessageDiffRunner = (
  cwd: string,
  args: string[],
  options?: { disableOptionalLocks?: boolean },
) => Promise<{ stdout: string }>;

const REF_KIND_ORDER: Record<GitRefOption['kind'], number> = {
  'local-branch': 0,
  'remote-branch': 1,
  tag: 2,
  other: 3,
};

function normalizeRefResultLimit(limit: number | undefined): number {
  if (!Number.isInteger(limit) || !limit || limit < 1) return DEFAULT_REF_RESULT_LIMIT;
  return Math.min(limit, MAX_REF_RESULT_LIMIT);
}

function normalizeRefSearchQuery(query: string | undefined): string | null {
  const trimmed = query?.trim() ?? '';
  if (!trimmed) return '';
  return /^[A-Za-z0-9._/@{}~^+-]+$/.test(trimmed) ? trimmed : null;
}

function refPatternsForQuery(query: string): string[] {
  // Keeps opening the selector cheap by avoiding large remote/tag namespaces until search.
  if (!query) return ['refs/heads'];
  if (query.startsWith('refs/')) return [`${query}*`];
  if (query.includes('/')) {
    return [
      `refs/heads/${query}*`,
      `refs/remotes/${query}*`,
      `refs/tags/${query}*`,
    ];
  }
  return [
    `refs/heads/${query}*`,
    `refs/remotes/${query}*`,
    `refs/remotes/*/${query}*`,
    `refs/tags/${query}*`,
  ];
}

function gitRefDisplayName(refname: string): Pick<GitRefOption, 'name' | 'kind'> {
  if (refname.startsWith('refs/heads/')) {
    return { name: refname.slice('refs/heads/'.length), kind: 'local-branch' };
  }
  if (refname.startsWith('refs/remotes/')) {
    return { name: refname.slice('refs/remotes/'.length), kind: 'remote-branch' };
  }
  if (refname.startsWith('refs/tags/')) {
    return { name: refname.slice('refs/tags/'.length), kind: 'tag' };
  }
  return { name: refname, kind: 'other' };
}

function parseGitRefLine(line: string, currentBranch: string | null, head: string): GitRefOption | null {
  if (!line) return null;
  const [refname, objectName] = line.split('\0');
  if (!refname) return null;
  if (refname.startsWith('refs/remotes/') && refname.endsWith('/HEAD')) return null;

  const { name, kind } = gitRefDisplayName(refname);
  const isCurrent =
    kind === 'local-branch'
      ? currentBranch === name
      : !currentBranch && Boolean(head) && objectName === head;
  return {
    name,
    ref: refname,
    kind,
    ...(isCurrent ? { isCurrent: true } : {}),
  };
}

function sortGitRefs(refs: GitRefOption[]): GitRefOption[] {
  return refs.sort((a, b) => {
    const kindDelta = REF_KIND_ORDER[a.kind] - REF_KIND_ORDER[b.kind];
    if (kindDelta !== 0) return kindDelta;
    return a.name.localeCompare(b.name);
  });
}

async function resolveLocalBranchCheckoutName(
  projectPath: string,
  ref: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const branch = ref.startsWith('refs/heads/')
    ? ref.slice('refs/heads/'.length)
    : ref.startsWith('refs/')
      ? ''
      : ref;
  if (!branch) return null;

  try {
    await runGit(
      projectPath,
      ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
      readOnlyGitOptions({ signal }),
    );
    return branch;
  } catch {
    return null;
  }
}

async function resolveDetachedHeadLabel(projectPath: string, head: string, signal?: AbortSignal): Promise<string> {
  try {
    const { stdout } = await runGit(
      projectPath,
      [
        'for-each-ref',
        '--format=%(refname:short)',
        '--points-at',
        'HEAD',
        'refs/remotes',
        'refs/tags',
      ],
      readOnlyGitOptions({ signal }),
    );
    const label = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.endsWith('/HEAD'))[0];
    if (label) return label;
  } catch {
    // Unknown detached refs fall through to a short SHA.
  }

  try {
    const { stdout } = await runGit(
      projectPath,
      ['rev-parse', '--short', 'HEAD'],
      readOnlyGitOptions({ signal }),
    );
    return stdout.trim() || head.slice(0, 7) || 'HEAD';
  } catch {
    return head.slice(0, 7) || 'HEAD';
  }
}

export async function collectCommitMessageDiffContext(
  projectPath: string,
  files: string[],
  runGitFn: CommitMessageDiffRunner = runGit,
): Promise<string> {
  let diffContext = '';
  for (const chunk of chunkGitPathspecs(files)) {
    try {
      const { stdout } = await runGitFn(projectPath, [
        'diff',
        '--cached',
        '--no-ext-diff',
        '--no-color',
        `-U${COMMIT_MESSAGE_DIFF_CONTEXT_LINES}`,
        '--',
        ...chunk,
      ], readOnlyGitOptions());
      if (stdout) {
        diffContext += `${diffContext ? '\n' : ''}${stdout}`;
      }
    } catch (error) {
      logger.error(`Error getting staged diff for ${chunk.length} selected files:`, error);
    }
  }
  return diffContext;
}

export function createStatusOperations(agents: GitAgentRunner) {
  async function getStatus({ projectPath }: ProjectOptions): Promise<unknown> {
    await assertGitRepository(projectPath);

    let branch = 'main';
    let hasCommits = true;
    try {
      const { stdout: branchOutput } = await runGit(
        projectPath,
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        readOnlyGitOptions(),
      );
      branch = branchOutput.trim();
      if (branch === 'HEAD') {
        const { stdout: headOutput } = await runGit(
          projectPath,
          ['rev-parse', '--verify', 'HEAD'],
          readOnlyGitOptions(),
        );
        branch = await resolveDetachedHeadLabel(projectPath, headOutput.trim());
      }
    } catch (error) {
      const message = errorMessage(error);
      if (message.includes('unknown revision') || message.includes('ambiguous argument')) {
        hasCommits = false;
        branch = 'main';
      } else {
        throw error;
      }
    }

    const { stdout: statusOutput } = await runGit(
      projectPath,
      ['status', '--porcelain', '-uall'],
      readOnlyGitOptions(),
    );

    const modified: string[] = [];
    const added: string[] = [];
    const deleted: string[] = [];
    const untracked: string[] = [];
    statusOutput.split('\n').forEach((line) => {
      if (!line.trim()) return;
      const status = line.substring(0, 2);
      const file = line.substring(3).trim().replace(/\/+$/g, '');
      if (!file) return;
      if (status === 'M ' || status === ' M' || status === 'MM') {
        modified.push(file);
      } else if (status === 'A ' || status === 'AM') {
        added.push(file);
      } else if (status === 'D ' || status === ' D') {
        deleted.push(file);
      } else if (status === '??') {
        untracked.push(file);
      }
    });

    return { branch, hasCommits, modified, added, deleted, untracked };
  }

  async function getDiff({ projectPath, file }: FileOptions): Promise<unknown> {
    await assertGitRepository(projectPath);

    const { stdout: statusOutput } = await runGit(
      projectPath,
      ['status', '--porcelain', '--', file],
      readOnlyGitOptions(),
    );
    const isUntracked = statusOutput.startsWith('??');
    const isDeleted = statusOutput.trim().startsWith('D ') || statusOutput.trim().startsWith(' D');

    let diff;
    if (isUntracked) {
      const filePath = resolvePathWithinProject(projectPath, file);
      const stats = await fs.stat(filePath);
      if (stats.isDirectory()) {
        diff = `--- directory: ${file}`;
      } else {
        const fileContent = await fs.readFile(filePath, 'utf-8');
        const lines = fileContent.split('\n');
        diff = `--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}`;
      }
    } else if (isDeleted) {
      const { stdout: fileContent } = await runGit(
        projectPath,
        ['show', `HEAD:${file}`],
        readOnlyGitOptions(),
      );
      const lines = fileContent.split('\n');
      diff = `--- a/${file}\n+++ /dev/null\n@@ -1,${lines.length} +0,0 @@\n${lines.map((line) => `-${line}`).join('\n')}`;
    } else {
      const { stdout: unstagedDiff } = await runGit(
        projectPath,
        ['diff', '--', file],
        readOnlyGitOptions(),
      );
      if (unstagedDiff) {
        diff = stripDiffHeaders(unstagedDiff);
      } else {
        const { stdout: stagedDiff } = await runGit(
          projectPath,
          ['diff', '--cached', '--', file],
          readOnlyGitOptions(),
        );
        diff = stripDiffHeaders(stagedDiff) || '';
      }
    }

    return { diff };
  }

  async function getFileWithDiff({ projectPath, file }: FileOptions): Promise<unknown> {
    await assertGitRepository(projectPath);

    const { stdout: statusOutput } = await runGit(
      projectPath,
      ['status', '--porcelain', '--', file],
      readOnlyGitOptions(),
    );
    const isUntracked = statusOutput.startsWith('??');
    const isDeleted = statusOutput.trim().startsWith('D ') || statusOutput.trim().startsWith(' D');

    let currentContent = '';
    let oldContent = '';

    if (isDeleted) {
      const { stdout: headContent } = await runGit(
        projectPath,
        ['show', `HEAD:${file}`],
        readOnlyGitOptions(),
      );
      oldContent = headContent;
      currentContent = headContent;
    } else {
      const filePath = resolvePathWithinProject(projectPath, file);
      const stats = await fs.stat(filePath);
      if (stats.isDirectory()) {
        throw new GitDomainError('INVALID_INPUT', 'Cannot generate a line diff for a directory. Select a file instead.');
      }
      currentContent = await fs.readFile(filePath, 'utf-8');
      if (!isUntracked) {
        try {
          const { stdout: headContent } = await runGit(
            projectPath,
            ['show', `HEAD:${file}`],
            readOnlyGitOptions(),
          );
          oldContent = headContent;
        } catch {
          oldContent = '';
        }
      }
    }

    return { currentContent, oldContent, isDeleted, isUntracked };
  }

  async function initialCommit({ projectPath }: ProjectOptions): Promise<unknown> {
    await assertGitRepository(projectPath);

    try {
      await runGit(projectPath, ['rev-parse', 'HEAD'], readOnlyGitOptions());
      throw new GitDomainError('INVALID_INPUT', 'Initial commit is only available for repositories with no existing commits.');
    } catch (e) {
      if (e instanceof GitDomainError) throw e;
      // Expected: rev-parse fails when there are no commits
    }

    await runGit(projectPath, ['add', '.']);
    const { stdout } = await runGit(projectPath, ['commit', '-m', 'Initial commit']);
    return { success: true, output: stdout, message: 'Initial commit created successfully' };
  }

  async function commit({ projectPath, message, files }: CommitOptions): Promise<unknown> {
    await assertGitRepository(projectPath);
    for (const file of files) {
      await runGit(projectPath, ['add', '--', file]);
    }
    const { stdout } = await runGit(projectPath, ['commit', '-m', message]);
    return { success: true, output: stdout };
  }

  async function getRefs({
    projectPath,
    query,
    limit,
    signal,
  }: GitRefsOptions): Promise<GitRefsResponse> {
    await assertGitRepository(projectPath);
    const normalizedQuery = normalizeRefSearchQuery(query);
    if (normalizedQuery === null) return { refs: [] };

    let currentBranch: string | null = null;
    let head = '';

    try {
      const { stdout } = await runGit(
        projectPath,
        ['symbolic-ref', '--quiet', '--short', 'HEAD'],
        readOnlyGitOptions({ signal }),
      );
      currentBranch = stdout.trim() || null;
    } catch {
      currentBranch = null;
    }

    try {
      const { stdout } = await runGit(
        projectPath,
        ['rev-parse', '--verify', 'HEAD'],
        readOnlyGitOptions({ signal }),
      );
      head = stdout.trim();
    } catch {
      head = '';
    }

    const { stdout } = await runGit(
      projectPath,
      [
        'for-each-ref',
        `--count=${normalizeRefResultLimit(limit)}`,
        '--format=%(refname)%00%(objectname)',
        ...refPatternsForQuery(normalizedQuery),
      ],
      readOnlyGitOptions({ signal }),
    );
    const refs = sortGitRefs(
      stdout
        .split('\n')
        .map((line) => parseGitRefLine(line, currentBranch, head))
        .filter((ref): ref is GitRefOption => Boolean(ref)),
    );
    return { refs };
  }

  async function getBranches(options: ProjectOptions): Promise<unknown> {
    const { refs } = await getRefs(options);
    const branches = refs
      .filter((ref) => ref.kind === 'local-branch')
      .map((ref) => ref.name)
      .filter((branch, index, self) => self.indexOf(branch) === index);
    return { branches };
  }

  async function checkout({ projectPath, ref, signal }: CheckoutOptions): Promise<unknown> {
    await assertGitRepository(projectPath);
    await assertExistingCommitRef(projectPath, ref, 'checkout', signal);
    const localBranch = await resolveLocalBranchCheckoutName(projectPath, ref, signal);
    const args = localBranch
      ? ['checkout', localBranch]
      : ['checkout', '--detach', ref];
    const { stdout } = await runGit(projectPath, args);
    return { success: true, output: stdout };
  }

  async function createBranch({ projectPath, branch, baseRef, signal }: BranchOptions): Promise<unknown> {
    await assertGitRepository(projectPath);
    await assertSafeBranchName(projectPath, branch, 'branch name', signal);
    if (baseRef) await assertExistingCommitRef(projectPath, baseRef, 'base', signal);
    const args = ['checkout', '-b', branch];
    if (baseRef) args.push(baseRef);
    const { stdout } = await runGit(projectPath, args);
    return { success: true, output: stdout };
  }

  async function generateCommitMessageForFiles({
    projectPath,
    files,
    agentId,
    model,
    apiProviderId,
    modelEndpointId,
    modelProtocol,
    customPrompt,
    useCommonDirPrefix,
  }: CommitMessageFileOptions): Promise<CommitMessageGenerationResult> {
    if (!Array.isArray(files) || files.length === 0) {
      throw new GitDomainError('COMMIT_MESSAGE_NO_STAGED_FILES', 'No staged files to generate a commit message.');
    }

    const diffContext = await collectCommitMessageDiffContext(projectPath, files);

    if (!diffContext.trim()) {
      throw new GitDomainError('COMMIT_MESSAGE_NO_STAGED_FILES', 'No staged changes found for selected files.');
    }

    const message = await generateCommitMessage(
      files,
      diffContext,
      agentId,
      projectPath,
      (prompt: string, opts: RunSingleQueryOptions) => agents.runSingleQuery(prompt, opts),
      { model, apiProviderId, modelEndpointId, modelProtocol, customPrompt },
    );
    const directoryPrefix = useCommonDirPrefix ? computeCommonDirPrefix(files) : '';
    return {
      message: directoryPrefix ? applyDirPrefix(message, directoryPrefix) : message,
      directoryPrefix,
    };
  }

  async function getRemoteStatus({ projectPath }: ProjectOptions): Promise<unknown> {
    await assertGitRepository(projectPath);

    const { stdout: currentBranch } = await runGit(
      projectPath,
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      readOnlyGitOptions(),
    );
    const branch = currentBranch.trim();

    let trackingBranch: string;
    let remoteName: string;
    try {
      const { stdout } = await runGit(
        projectPath,
        ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`],
        readOnlyGitOptions(),
      );
      trackingBranch = stdout.trim();
      remoteName = trackingBranch.split('/')[0];
    } catch {
      let hasRemote = false;
      let foundRemoteName: string | null = null;
      try {
        const { stdout } = await runGit(projectPath, ['remote'], readOnlyGitOptions());
        const remotes = stdout.trim().split('\n').filter((r) => r.trim());
        if (remotes.length > 0) {
          hasRemote = true;
          foundRemoteName = remotes.includes('origin') ? 'origin' : remotes[0];
        }
      } catch { }

      return {
        hasRemote,
        hasUpstream: false,
        branch,
        remoteName: foundRemoteName,
        message: 'No remote tracking branch configured',
      };
    }

    const { stdout: countOutput } = await runGit(
      projectPath,
      ['rev-list', '--count', '--left-right', `${trackingBranch}...HEAD`],
      readOnlyGitOptions(),
    );
    const [behind, ahead] = countOutput.trim().split('\t').map(Number);

    return {
      hasRemote: true,
      hasUpstream: true,
      branch,
      remoteBranch: trackingBranch,
      remoteName,
      ahead: ahead || 0,
      behind: behind || 0,
      isUpToDate: ahead === 0 && behind === 0,
    };
  }

  async function fetch({ projectPath }: ProjectOptions): Promise<unknown> {
    await assertGitRepository(projectPath);

    const { stdout: fetchBranch } = await runGit(
      projectPath,
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      readOnlyGitOptions(),
    );
    const branch = fetchBranch.trim();

    let remoteName = 'origin';
    try {
      const { stdout } = await runGit(
        projectPath,
        ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`],
        readOnlyGitOptions(),
      );
      remoteName = stdout.trim().split('/')[0];
    } catch {
      logger.info('No upstream configured, using origin as fallback');
    }

    const { stdout } = await runGit(projectPath, ['fetch', remoteName]);
    return { success: true, output: stdout || 'Fetch completed successfully', remoteName };
  }

  async function pull({ projectPath }: ProjectOptions): Promise<unknown> {
    await assertGitRepository(projectPath);

    const { stdout: pullBranch } = await runGit(
      projectPath,
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      readOnlyGitOptions(),
    );
    const branch = pullBranch.trim();

    let remoteName = 'origin';
    let remoteBranch = branch;
    try {
      const { stdout } = await runGit(
        projectPath,
        ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`],
        readOnlyGitOptions(),
      );
      const tracking = stdout.trim();
      remoteName = tracking.split('/')[0];
      remoteBranch = tracking.split('/').slice(1).join('/');
    } catch {
      logger.info('No upstream configured, using origin/branch as fallback');
    }

    const { stdout } = await runGit(projectPath, ['pull', remoteName, remoteBranch]);
    return {
      success: true,
      output: stdout || 'Pull completed successfully',
      remoteName,
      remoteBranch,
    };
  }

  // Returns list of configured remotes with their fetch URLs.
  async function getRemotes({ projectPath }: ProjectOptions): Promise<unknown> {
    await assertGitRepository(projectPath);

    const { stdout } = await runGit(projectPath, ['remote', '-v'], readOnlyGitOptions());
    const seen = new Map<string, RemoteInfo>();
    for (const line of stdout.trim().split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split(/\s+/);
      if (parts.length >= 2 && !seen.has(parts[0])) {
        seen.set(parts[0], { name: parts[0], url: parts[1] });
      }
    }
    return { remotes: Array.from(seen.values()) };
  }

  // Pushes to a specific remote. Never sets upstream tracking.
  async function push({ projectPath, remote, remoteBranch }: PushOptions): Promise<unknown> {
    await assertGitRepository(projectPath);

    const { stdout: headBranch } = await runGit(
      projectPath,
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      readOnlyGitOptions(),
    );
    const branch = headBranch.trim();
    const targetRemote = remote || 'origin';
    const targetBranch = remoteBranch || branch;
    assertSafeRemoteName(targetRemote);
    if (remoteBranch) {
      await assertSafeBranchName(projectPath, remoteBranch, 'remote branch name');
    }

    const { stdout } = await runGit(projectPath, ['push', targetRemote, `${branch}:${targetBranch}`]);
    return {
      success: true,
      output: stdout || 'Push completed successfully',
      remoteName: targetRemote,
      remoteBranch: targetBranch,
    };
  }

  async function discard({ projectPath, file }: FileOptions): Promise<unknown> {
    await assertGitRepository(projectPath);

    const { stdout: statusOutput } = await runGit(
      projectPath,
      ['status', '--porcelain', '--', file],
      readOnlyGitOptions(),
    );
    if (!statusOutput.trim()) {
      throw new GitDomainError('INVALID_INPUT', 'No local working-tree changes were found for this file.');
    }

    const status = statusOutput.substring(0, 2);
    if (status === '??') {
      const filePath = resolvePathWithinProject(projectPath, file);
      const stats = await fs.stat(filePath);
      if (stats.isDirectory()) {
        await fs.rm(filePath, { recursive: true, force: true });
      } else {
        await fs.unlink(filePath);
      }
    } else if (status.includes('M') || status.includes('D')) {
      await runGit(projectPath, ['restore', '--', file]);
    } else if (status.includes('A')) {
      await runGit(projectPath, ['reset', 'HEAD', '--', file]);
    }

    return { success: true, message: `Changes discarded for ${file}` };
  }

  async function deleteUntracked({ projectPath, file }: FileOptions): Promise<unknown> {
    await assertGitRepository(projectPath);

    const { stdout: statusOutput } = await runGit(
      projectPath,
      ['status', '--porcelain', '--', file],
      readOnlyGitOptions(),
    );
    if (!statusOutput.trim()) {
      throw new GitDomainError('INVALID_INPUT', 'The file is either tracked already or does not exist on disk.');
    }

    const status = statusOutput.substring(0, 2);
    if (status !== '??') {
      throw new GitDomainError('INVALID_INPUT', 'The file is tracked by Git. Use discard for tracked files.');
    }

    const filePath = resolvePathWithinProject(projectPath, file);
    const stats = await fs.stat(filePath);
    if (stats.isDirectory()) {
      await fs.rm(filePath, { recursive: true, force: true });
      return { success: true, message: `Untracked directory ${file} deleted successfully` };
    }

    await fs.unlink(filePath);
    return { success: true, message: `Untracked file ${file} deleted successfully` };
  }

  async function commitIndex({ projectPath, message }: CommitIndexOptions): Promise<unknown> {
    await assertGitRepository(projectPath);
    const { stdout } = await runGit(projectPath, ['commit', '-m', message]);
    return { success: true, output: stdout };
  }

  async function stageFile({ projectPath, file, mode }: StageFileOptions): Promise<unknown> {
    await assertGitRepository(projectPath);
    resolvePathWithinProject(projectPath, file);

    if (mode === 'stage') {
      await runGit(projectPath, ['add', '--', file]);
    } else {
      await runGit(projectPath, ['reset', 'HEAD', '--', file]);
    }
    return { success: true };
  }

  async function revertCommit({ projectPath, commit }: RevertCommitOptions): Promise<unknown> {
    await assertGitRepository(projectPath);
    await assertExistingCommitRef(projectPath, commit, 'commit');

    const { stdout: parentLine } = await runGit(
      projectPath,
      ['rev-list', '--parents', '-n', '1', commit],
      readOnlyGitOptions(),
    );
    const parentCount = parentLine.trim().split(/\s+/).filter(Boolean).length - 1;
    // Uses first parent for merge commits to match the commit screen default diff.
    const args = parentCount > 1
      ? ['revert', '--no-edit', '-m', '1', commit]
      : ['revert', '--no-edit', commit];
    const { stdout } = await runGit(projectPath, args);
    return { success: true, output: stdout || `Commit ${commit.slice(0, 7)} reverted` };
  }


  return {
    getStatus,
    getDiff,
    getFileWithDiff,
    initialCommit,
    commit,
    getBranches,
    getRefs,
    checkout,
    createBranch,
    generateCommitMessageForFiles,
    getRemoteStatus,
    getRemotes,
    fetch,
    pull,
    push,
    discard,
    deleteUntracked,
    commitIndex,
    stageFile,
    revertCommit,
  };
}
