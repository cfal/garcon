import { promises as fs } from 'fs';
import path from 'path';
import { GitDomainError } from './git-types.js';
import { generateCommitMessage } from './commit-message.js';
import { createLogger } from '../lib/log.js';
import { errorMessage, hasNodeErrorCode } from '../lib/errors.js';
import { getHttpIdleTimeoutSeconds } from '../config.js';
import { createGenerationRequestSignal } from '../settings/generation-limits.js';
import { applyDirPrefix, computeCommonDirPrefix } from './commit-prefix.ts';
import { chunkGitPathspecs, literalGitPathspec } from './pathspecs.js';
import { GIT_REF_RESULT_LIMITS, type GitCommandOptions } from './types.js';
import { DEFAULT_GIT_REF_SORT } from '../../common/git-refs.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import { probeWorktreeLayout } from './worktree-layout.js';
import { isExpectedMissingGitResult } from './comparison-errors.js';
import { commitSelectedFiles } from './selected-file-commit.js';
import type {
  BranchOptions,
  CheckoutOptions,
  CommitIndexOptions,
  CommitMessageGenerationResult,
  CommitMessageFileOptions,
  CommitOptions,
  FileOptions,
  GitAgentRunner,
  GitCommitResult,
  GitRefOption,
  GitRefsResponse,
  GitRefsOptions,
  GitRefSort,
  ProjectOptions,
  PushOptions,
  RemoteInfo,
  RevertCommitOptions,
  RunSingleQueryOptions,
  StagePathsOptions,
} from './types.js';
import {
  assertGitRepository,
  readOnlyGitOptions,
  resolvePathWithinProject,
  runGit,
  runGitWithStdin,
} from './run.js';
import {
  assertExistingCommitRef,
  assertSafeBranchName,
  assertSafeRemoteName,
} from './ref-validation.js';

const logger = createLogger('git:status');
const COMMIT_MESSAGE_DIFF_CONTEXT_LINES = 10;
const LOCAL_BRANCH_REF_PATTERN = 'refs/heads';
const WHOLE_INDEX_COMMIT_STATE_REFS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'];
// Network commands run within the HTTP idle budget minus a margin, so a slow
// remote surfaces a git error before the idle timeout drops the response.
const NETWORK_GIT_TIMEOUT_MARGIN_MS = 2_000;

function networkGitOptions(): GitCommandOptions {
  return {
    timeoutMs: Math.max(1_000, getHttpIdleTimeoutSeconds() * 1000 - NETWORK_GIT_TIMEOUT_MARGIN_MS),
    // Fails fast on credential prompts instead of hanging until the timeout.
    env: { GIT_TERMINAL_PROMPT: '0' },
  };
}
const repositoryCommitLock = new KeyedPromiseLock();
type CommitMessageDiffRunner = (
  cwd: string,
  args: string[],
  options?: { disableOptionalLocks?: boolean },
) => Promise<{ stdout: string }>;

async function runWithRepositoryCommitLock<T>(
  projectPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const layout = await probeWorktreeLayout(projectPath);
  const lockKey = await fs.realpath(layout?.commonDir ?? projectPath);
  return repositoryCommitLock.runExclusive(lockKey, operation);
}

function normalizeRefResultLimit(limit: number | undefined): number {
  if (!Number.isInteger(limit) || !limit || limit < 1) return GIT_REF_RESULT_LIMITS.default;
  return Math.min(limit, GIT_REF_RESULT_LIMITS.max);
}

async function hasCommitStateRef(projectPath: string, ref: string): Promise<boolean> {
  try {
    await runGit(
      projectPath,
      ['rev-parse', '--verify', '--quiet', ref],
      readOnlyGitOptions(),
    );
    return true;
  } catch (error) {
    if (isExpectedMissingGitResult(error)) return false;
    throw error;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (hasNodeErrorCode(error, 'ENOENT')) return false;
    throw error;
  }
}

async function hasRebaseOrAmConflictState(projectPath: string): Promise<boolean> {
  const { stdout } = await runGit(
    projectPath,
    [
      'rev-parse',
      '--git-path',
      'rebase-merge/stopped-sha',
      '--git-path',
      'rebase-merge/amend',
      '--git-path',
      'rebase-apply',
    ],
    readOnlyGitOptions(),
  );
  const [stoppedPath, amendPath, applyPath] = stdout
    .trimEnd()
    .split('\n')
    .map((statePath) => path.resolve(projectPath, statePath));

  if (await fileExists(applyPath)) return true;
  // Interactive edit stops permit isolated commits; conflicted stops omit the amend marker.
  return (await fileExists(stoppedPath)) && !(await fileExists(amendPath));
}

async function requiresWholeIndexCommit(projectPath: string): Promise<boolean> {
  // Git continuation states require preserving the complete staged operation.
  for (const ref of WHOLE_INDEX_COMMIT_STATE_REFS) {
    if (await hasCommitStateRef(projectPath, ref)) return true;
  }
  return hasRebaseOrAmConflictState(projectPath);
}

function normalizeRefSearchQuery(query: string | undefined): string | null {
  const trimmed = query?.trim() ?? '';
  if (!trimmed) return '';
  return /^[A-Za-z0-9._/@{}~^+-]+$/.test(trimmed) ? trimmed : null;
}

function refPatternsForQuery(query: string): string[] {
  // Keeps opening the selector cheap by avoiding large remote/tag namespaces until search.
  if (!query) return [LOCAL_BRANCH_REF_PATTERN];
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

function gitRefSortArgs(
  sort: GitRefSort,
  patterns: readonly string[],
): string[] {
  const canUseDefaultRefOrder =
    sort.key === 'name' &&
    sort.direction === 'asc' &&
    patterns.length === 1 &&
    patterns[0] === LOCAL_BRANCH_REF_PATTERN;
  // Git's full-refname order equals short-name order under this common prefix.
  // Omitting --sort lets --count stop iteration early.
  if (canUseDefaultRefOrder) return [];

  const directionPrefix = sort.direction === 'desc' ? '-' : '';
  const primary = sort.key === 'name' ? 'refname:lstrip=2' : 'creatordate';
  return ['--sort=refname', `--sort=${directionPrefix}${primary}`];
}

function creatorDateIso(value: string | undefined): string | null {
  if (!value || !/^-?\d+$/.test(value)) return null;
  const milliseconds = Number(value) * 1_000;
  if (!Number.isSafeInteger(milliseconds)) return null;
  const timestamp = new Date(milliseconds);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
}

function parseGitRefLine(line: string, currentBranch: string | null, head: string): GitRefOption | null {
  if (!line) return null;
  const [refname, objectName, creatorDate] = line.split('\0');
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
    updatedAt: creatorDateIso(creatorDate),
    ...(isCurrent ? { isCurrent: true } : {}),
  };
}

interface GitHeadIdentity {
  currentBranch: string | null;
  head: string;
}

async function readGitHeadIdentity(
  projectPath: string,
  signal?: AbortSignal,
): Promise<GitHeadIdentity> {
  try {
    const { stdout } = await runGit(
      projectPath,
      ['rev-parse', 'HEAD', '--symbolic-full-name', 'HEAD'],
      readOnlyGitOptions({ signal }),
    );
    const [head = '', symbolicHead = ''] = stdout.trim().split(/\r?\n/);
    const prefix = 'refs/heads/';
    return {
      head,
      currentBranch: symbolicHead.startsWith(prefix)
        ? symbolicHead.slice(prefix.length)
        : null,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { currentBranch: null, head: '' };
  }
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
  signal?: AbortSignal,
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
        ], readOnlyGitOptions({ signal }));
      if (stdout) {
        diffContext += `${diffContext ? '\n' : ''}${stdout}`;
      }
      } catch (error) {
        if (signal?.aborted) throw error;
        logger.error(`Error getting staged diff for ${chunk.length} selected files:`, error);
    }
  }
  return diffContext;
}

// Resolves the display branch and whether the repository has any commits.
// Detached HEAD falls back to a descriptive label.
async function resolveStatusBranch(projectPath: string): Promise<{ branch: string; hasCommits: boolean }> {
  try {
    const { stdout } = await runGit(
      projectPath,
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      readOnlyGitOptions(),
    );
    let branch = stdout.trim();
    if (branch === 'HEAD') {
      const { stdout: headOutput } = await runGit(
        projectPath,
        ['rev-parse', '--verify', 'HEAD'],
        readOnlyGitOptions(),
      );
      branch = await resolveDetachedHeadLabel(projectPath, headOutput.trim());
    }
    return { branch, hasCommits: true };
  } catch (error) {
    const message = errorMessage(error);
    if (message.includes('unknown revision') || message.includes('ambiguous argument')) {
      return { branch: 'main', hasCommits: false };
    }
    throw error;
  }
}

export function createStatusOperations(agents: GitAgentRunner) {
  async function getStatus({ projectPath }: ProjectOptions): Promise<unknown> {
    await assertGitRepository(projectPath);

    // Branch resolution and the working-tree scan are independent reads;
    // run them concurrently instead of paying sequential spawn latency.
    const [branchInfo, { stdout: statusOutput }] = await Promise.all([
      resolveStatusBranch(projectPath),
      runGit(projectPath, ['status', '--porcelain', '-uall'], readOnlyGitOptions()),
    ]);
    const { branch, hasCommits } = branchInfo;

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

  async function commit({ projectPath, message, files }: CommitOptions): Promise<GitCommitResult> {
    await assertGitRepository(projectPath);
    for (const file of files) {
      if (!file) throw new GitDomainError('INVALID_INPUT', 'Pathspecs cannot be empty.');
      if (file.includes('\0')) {
        throw new GitDomainError('INVALID_INPUT', 'Pathspecs cannot contain NUL bytes.');
      }
      try {
        resolvePathWithinProject(projectPath, file);
      } catch {
        throw new GitDomainError(
          'INVALID_INPUT',
          'Pathspecs must resolve inside the project root.',
        );
      }
    }
    return runWithRepositoryCommitLock(projectPath, async () => {
      if (!(await requiresWholeIndexCommit(projectPath))) {
        const result = await commitSelectedFiles(projectPath, message, files);
        return { success: true, ...result, commitScope: 'selected-files' };
      }

      for (const file of files) {
        await runGit(projectPath, ['add', '--', literalGitPathspec(file)]);
      }
      const { stdout } = await runGit(projectPath, ['commit', '-m', message]);
      return {
        success: true,
        output: stdout,
        commitScope: 'whole-index',
        indexSynchronized: true,
      };
    });
  }

  async function getRefs({
    projectPath,
    query,
    limit,
    sort = DEFAULT_GIT_REF_SORT,
    signal,
  }: GitRefsOptions): Promise<GitRefsResponse> {
    const normalizedQuery = normalizeRefSearchQuery(query);
    if (normalizedQuery === null) {
      await assertGitRepository(projectPath, signal);
      return { refs: [] };
    }

    const refPatterns = refPatternsForQuery(normalizedQuery);
    const refArgs = [
      'for-each-ref',
      `--count=${normalizeRefResultLimit(limit)}`,
      ...gitRefSortArgs(sort, refPatterns),
      '--format=%(refname)%00%(objectname)%00%(creatordate:unix)',
      ...refPatterns,
    ];
    const [repositoryResult, identityResult, refResult] =
      await Promise.allSettled([
        assertGitRepository(projectPath, signal),
        readGitHeadIdentity(projectPath, signal),
        runGit(projectPath, refArgs, readOnlyGitOptions({ signal })),
      ]);

    // Preserves repository validation as the canonical failure; failures wait for every command to settle.
    if (repositoryResult.status === 'rejected') throw repositoryResult.reason;
    if (identityResult.status === 'rejected') throw identityResult.reason;
    if (refResult.status === 'rejected') throw refResult.reason;

    const identity = identityResult.value;
    const refs = refResult.value.stdout
      .split('\n')
      .map((line) => parseGitRefLine(line, identity.currentBranch, identity.head))
      .filter((ref): ref is GitRefOption => Boolean(ref));
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

  async function checkout({ projectPath, ref, refKind, signal }: CheckoutOptions): Promise<unknown> {
    await assertGitRepository(projectPath);
    await assertExistingCommitRef(projectPath, ref, 'checkout', signal);
    const localBranch = refKind === undefined || refKind === 'local-branch'
      ? await resolveLocalBranchCheckoutName(projectPath, ref, signal)
      : null;
    if (refKind === 'local-branch' && !localBranch) {
      throw new GitDomainError('INVALID_INPUT', 'Invalid local branch ref.');
    }
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
    thinkingMode,
      customPrompt,
      useCommonDirPrefix,
      signal,
    }: CommitMessageFileOptions): Promise<CommitMessageGenerationResult> {
    if (!Array.isArray(files) || files.length === 0) {
      throw new GitDomainError('COMMIT_MESSAGE_NO_STAGED_FILES', 'No staged files to generate a commit message.');
    }

      const generationSignal = signal ?? createGenerationRequestSignal();
      const diffContext = await collectCommitMessageDiffContext(
        projectPath,
        files,
        runGit,
        generationSignal,
      );

    if (!diffContext.trim()) {
      throw new GitDomainError('COMMIT_MESSAGE_NO_STAGED_FILES', 'No staged changes found for selected files.');
    }

    const message = await generateCommitMessage(
      files,
      diffContext,
      agentId,
      projectPath,
      (prompt: string, opts: RunSingleQueryOptions) => agents.runSingleQuery(prompt, opts),
        {
          model,
          apiProviderId,
          modelEndpointId,
          modelProtocol,
          thinkingMode,
          customPrompt,
          signal: generationSignal,
        },
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

    const { stdout } = await runGit(projectPath, ['fetch', remoteName], networkGitOptions());
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

    const { stdout } = await runGit(
      projectPath,
      ['pull', remoteName, remoteBranch],
      networkGitOptions(),
    );
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
      if (remoteBranch !== branch) {
        throw new GitDomainError('INVALID_INPUT', 'Remote branch must match the current local branch.');
      }
    }

    const { stdout } = await runGit(
      projectPath,
      ['push', targetRemote, `${branch}:${targetBranch}`],
      networkGitOptions(),
    );
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
    } else if (status[0] === 'A') {
      // Unstage first so staged-added states (A, AM, AD) fully discard;
      // restore would resurrect an AD file or leave an AM file staged.
      await runGit(projectPath, ['reset', 'HEAD', '--', file]);
    } else if (status.includes('M') || status.includes('D')) {
      await runGit(projectPath, ['restore', '--', file]);
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
    return runWithRepositoryCommitLock(projectPath, async () => {
      const { stdout } = await runGit(projectPath, ['commit', '-m', message]);
      return { success: true, output: stdout };
    });
  }

  function pathspecStdin(paths: string[]): string {
    return paths.map((filePath) => `${filePath}\0`).join('');
  }

  async function stagePaths({ projectPath, paths, mode }: StagePathsOptions): Promise<unknown> {
    await assertGitRepository(projectPath);
    if (paths.length === 0) {
      throw new GitDomainError('INVALID_INPUT', 'At least one path is required.');
    }

    for (const filePath of paths) {
      if (filePath.length === 0) {
        throw new GitDomainError('INVALID_INPUT', 'Pathspecs cannot be empty.');
      }
      if (filePath.includes('\0')) {
        throw new GitDomainError('INVALID_INPUT', 'Pathspecs cannot contain NUL bytes.');
      }
      resolvePathWithinProject(projectPath, filePath);
    }

    const input = pathspecStdin(paths);
    if (mode === 'stage') {
      await runGitWithStdin(projectPath, ['add', '--pathspec-from-file=-', '--pathspec-file-nul'], input);
    } else {
      await runGitWithStdin(
        projectPath,
        ['reset', '-q', 'HEAD', '--pathspec-from-file=-', '--pathspec-file-nul'],
        input,
      );
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
    stagePaths,
    revertCommit,
  };
}
