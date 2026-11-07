import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, stat, unlink } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';
import { isManagedWorktreeSnapshot, type ManagedWorktreeSnapshot } from '../../../common/git-managed-worktrees.js';
import { GitServiceError } from '../../../common/git-error.js';
import { isRecord } from '../../../common/json.js';
import { hasNodeErrorCode } from '../../common/errors.js';
import { toExecutorPath } from '../../common/executor-path.js';
import { syncDirectory, writeJsonFileAtomic } from '../../common/json-file-store.js';
import { resolveRealWithinBase } from '../../common/path-boundary.js';
import { requireCompleteGitHistory, requireExactCommit, runExactGit, runExactGitWithStdin } from './exact-objects.js';
import { assertSafeBranchName } from './ref-validation.js';
import { isGitCancellation } from './operation-context.js';
import { GitOutputLimitError, readOnlyGitOptions } from './run.js';
import type { GitOperationOptions } from './types.js';

interface ManagedWorktreeMarker extends Omit<ManagedWorktreeSnapshot, 'head' | 'dirty' | 'worktreeIdentity'> {
  readonly version: 1;
  readonly worktreeIdentity: string | null;
}

function conflict(message: string): never { throw new GitServiceError('GIT_INVALID_INPUT', message); }

async function directoryIdentity(directory: string): Promise<string> {
  const canonical = await realpath(directory);
  const info = await stat(canonical, { bigint: true });
  if (!info.isDirectory()) conflict('Managed Git identity is not a directory.');
  return createHash('sha256').update(JSON.stringify([toExecutorPath(canonical),
    info.dev.toString(), info.ino.toString(), info.birthtimeNs.toString()])).digest('hex');
}

async function gitValue(projectPath: string, args: string[]): Promise<string> {
  return (await runExactGit(projectPath, args, readOnlyGitOptions({ maxStdoutBytes: 64 * 1024 }))).stdout.replace(/\r?\n$/, '');
}

async function repository(projectPath: string) {
  const commonDir = await realpath(await gitValue(projectPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  return { commonDir, identity: await directoryIdentity(commonDir) };
}

async function absent(path: string): Promise<void> {
  try { await lstat(path); }
  catch (error) { if (hasNodeErrorCode(error, 'ENOENT')) return; throw error; }
  conflict('Managed resource destination already exists.');
}

async function markerPath(commonDir: string, id: string, create: boolean): Promise<string> {
  const directory = join(commonDir, 'garcon-managed-worktrees');
  if (create) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await syncDirectory(commonDir);
  }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) conflict('Managed resource storage is not a directory.');
  return join(directory, `${id}.json`);
}

async function readMarker(path: string): Promise<ManagedWorktreeMarker> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 64 * 1024) conflict('Invalid managed resource marker.');
    const bytes = Buffer.alloc(64 * 1024 + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length === bytes.length) conflict('Invalid managed resource marker.');
    let value: unknown;
    try { value = JSON.parse(bytes.subarray(0, length).toString('utf8')); }
    catch { conflict('Invalid managed resource marker.'); }
    if (!isRecord(value) || value.version !== 1 || value.worktreeIdentity !== null && typeof value.worktreeIdentity !== 'string'
      || !Object.keys(value).every(key => ['version', 'operationId', 'managedResourceId', 'repositoryIdentity',
        'worktreeIdentity', 'worktreePath', 'branch', 'baseCommit'].includes(key))) {
      conflict('Invalid managed resource marker.');
    }
    const { version: _version, ...identity } = value;
    const snapshot = { ...identity, worktreeIdentity: value.worktreeIdentity ?? 'pending', head: identity.baseCommit, dirty: false };
    if (!isManagedWorktreeSnapshot(snapshot)) conflict('Invalid managed resource marker.');
    const { head: _head, dirty: _dirty, ...parsed } = snapshot;
    return { ...parsed, version: 1, worktreeIdentity: value.worktreeIdentity };
  } finally { await file.close(); }
}

async function reserveMarker(path: string, marker: ManagedWorktreeMarker): Promise<void> {
  const directory = dirname(path);
  const temporary = join(directory, `.reservation-${randomUUID()}.json`);
  const created: string[] = [];
  let identity: { dev: bigint; ino: bigint } | undefined;
  try {
    const file = await open(temporary, 'wx', 0o600);
    created.push(temporary);
    try { identity = await file.stat({ bigint: true }); await file.writeFile(JSON.stringify(marker)); await file.sync(); }
    finally { await file.close(); }
    await syncDirectory(directory);
    for (const [kind, value] of [['path', marker.worktreePath], ['branch', marker.branch]] as const) {
      const key = createHash('sha256').update(value).digest('hex');
      const destination = join(directory, `${kind}-${key}.json`);
      await link(temporary, destination); created.push(destination);
      await syncDirectory(directory);
    }
    await link(temporary, path); created.push(path);
    await syncDirectory(directory);
    await unlink(temporary);
    await syncDirectory(directory);
  } catch (error) {
    if (hasNodeErrorCode(error, 'EEXIST')) {
      // Collision rollback precedes every Git effect and only removes this call's exclusive links.
      try {
        for (const destination of created.reverse()) {
          let current;
          try { current = await lstat(destination, { bigint: true }); }
          catch (failure) { if (hasNodeErrorCode(failure, 'ENOENT')) continue; throw failure; }
          if (!identity || current.dev !== identity.dev || current.ino !== identity.ino) throw new Error('Reservation identity changed.');
          await unlink(destination);
        }
        await syncDirectory(directory);
      } catch { throw new GitServiceError('GIT_MUTATION_OUTCOME_UNKNOWN', 'Managed reservation rollback could not be confirmed.'); }
      conflict('Managed resource identity, path, or branch is already reserved.');
    }
    throw new GitServiceError('GIT_MUTATION_OUTCOME_UNKNOWN', 'Managed resource reservation could not be confirmed.');
  }
}

async function requireAvailableDestination(projectPath: string, worktreePath: string, branch: string, baseCommit: string): Promise<void> {
  await absent(worktreePath);
  const registered = (await gitValue(projectPath, ['worktree', 'list', '--porcelain', '-z'])).split('\0');
  for (const field of registered) {
    if (field === `branch refs/heads/${branch}`) conflict('Managed branch is already selected by another worktree.');
    if (!field.startsWith('worktree ')) continue;
    const path = field.slice(9);
    if (await resolveRealWithinBase(parse(path).root, path) === worktreePath) conflict('Managed path is already registered as a worktree.');
  }
  // Git's aborted transaction detects dangling namespace collisions in both ref storage formats.
  try {
    await runExactGitWithStdin(projectPath, ['update-ref', '--stdin'],
      `start\noption no-deref\ncreate refs/heads/${branch} ${baseCommit}\nprepare\nabort\n`,
      readOnlyGitOptions({ maxStdoutBytes: 64 * 1024 }));
  } catch (error) {
    if (isGitCancellation(error) || !(error instanceof Error) || !('code' in error) || typeof error.code !== 'number') throw error;
    conflict('Managed branch cannot be reserved in the current ref namespace.');
  }
}

async function isDirty(worktreePath: string): Promise<boolean> {
  try {
    return Boolean((await runExactGit(worktreePath, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=none'],
      readOnlyGitOptions({ maxStdoutBytes: 64 * 1024 }))).stdout);
  } catch (error) {
    if (error instanceof GitOutputLimitError && error.stream === 'stdout') return true;
    throw error;
  }
}

async function observe(marker: ManagedWorktreeMarker, worktreePath: string): Promise<ManagedWorktreeSnapshot> {
  if (marker.worktreeIdentity === null) throw new GitServiceError('GIT_MUTATION_OUTCOME_UNKNOWN', 'Managed worktree creation has no confirmed ownership observation.');
  const actual = await worktreeIdentity(worktreePath);
  if (actual.repositoryIdentity !== marker.repositoryIdentity || actual.worktreeIdentity !== marker.worktreeIdentity
    || actual.worktreePath !== marker.worktreePath || actual.branch !== marker.branch) {
    conflict('Managed worktree identity changed.');
  }
  const head = await gitValue(worktreePath, ['rev-parse', '--verify', 'HEAD']);
  const dirty = await isDirty(worktreePath);
  if (await gitValue(worktreePath, ['rev-parse', '--verify', 'HEAD']) !== head) conflict('Managed worktree changed during observation.');
  const after = await worktreeIdentity(worktreePath);
  if (JSON.stringify(after) !== JSON.stringify(actual)) conflict('Managed worktree identity changed during observation.');
  const { version: _version, ...identity } = marker;
  return { ...identity, worktreeIdentity: marker.worktreeIdentity, head, dirty };
}

async function worktreeIdentity(worktreePath: string) {
  const root = await realpath(await gitValue(worktreePath, ['rev-parse', '--show-toplevel']));
  if (root !== await realpath(worktreePath)) conflict('Managed path is not the worktree root.');
  const admin = await realpath(await gitValue(worktreePath, ['rev-parse', '--absolute-git-dir']));
  const repo = await repository(worktreePath);
  if (admin === repo.commonDir) conflict('The primary checkout is not a managed worktree.');
  const headRef = await gitValue(worktreePath, ['symbolic-ref', '--quiet', 'HEAD']);
  if (!headRef.startsWith('refs/heads/')) conflict('Managed HEAD is not attached to a branch.');
  return { repositoryIdentity: repo.identity, worktreePath: toExecutorPath(root),
    worktreeIdentity: createHash('sha256').update(JSON.stringify([await directoryIdentity(root), await directoryIdentity(admin)])).digest('hex'),
    branch: headRef.slice('refs/heads/'.length) };
}

export function createManagedWorktreeOperations() {
  async function createManagedWorktree(input: GitOperationOptions<'createManagedWorktree'>) {
    const { projectPath, worktreePath, operationId, managedResourceId, branch, baseCommit } = input;
    if (branch.includes('=')) conflict('Managed branch must not contain config delimiters.');
    await assertSafeBranchName(projectPath, branch);
    try { await gitValue(projectPath, ['check-ref-format', `refs/heads/${branch}`]); }
    catch { conflict('Managed branch must be a literal branch name.'); }
    await requireCompleteGitHistory(projectPath);
    await requireExactCommit(projectPath, baseCommit);
    await requireAvailableDestination(projectPath, worktreePath, branch, baseCommit);
    const repo = await repository(projectPath);
    const path = await markerPath(repo.commonDir, managedResourceId, true);
    await absent(path);
    const marker: ManagedWorktreeMarker = { version: 1, operationId, managedResourceId,
      repositoryIdentity: repo.identity, worktreeIdentity: null, worktreePath: toExecutorPath(worktreePath), branch, baseCommit };
    await reserveMarker(path, marker);
    // A partial creation retains its marker; another create never adopts or compensates it.
    try {
      input.signal?.throwIfAborted();
      await runExactGit(projectPath, ['worktree', 'add', '--no-track', '-b', branch, worktreePath, baseCommit]);
      const actual = await worktreeIdentity(worktreePath);
      if (actual.repositoryIdentity !== marker.repositoryIdentity || actual.worktreePath !== marker.worktreePath
        || actual.branch !== marker.branch) conflict('Created worktree does not match its reservation.');
      const confirmed = { ...marker, worktreeIdentity: actual.worktreeIdentity };
      const managed = await observe(confirmed, worktreePath);
      if (managed.head !== baseCommit || managed.dirty) conflict('Created worktree is not clean at its reserved commit.');
      await writeJsonFileAtomic(path, confirmed, { mode: 0o600 });
      return { success: true as const, managed };
    } catch {
      throw new GitServiceError('GIT_MUTATION_OUTCOME_UNKNOWN', 'Managed worktree creation could not be confirmed. Inspect its exact ownership marker before proceeding.');
    }
  }

  async function inspectManagedWorktree(input: GitOperationOptions<'inspectManagedWorktree'>) {
    await requireCompleteGitHistory(input.projectPath);
    const repo = await repository(input.projectPath);
    let marker: ManagedWorktreeMarker;
    try { marker = await readMarker(await markerPath(repo.commonDir, input.managedResourceId, false)); }
    catch (error) { if (hasNodeErrorCode(error, 'ENOENT')) return { managed: null }; throw error; }
    if (marker.operationId !== input.operationId || marker.managedResourceId !== input.managedResourceId
      || marker.repositoryIdentity !== repo.identity || marker.worktreePath !== toExecutorPath(input.worktreePath)) {
      conflict('Managed resource marker does not match the requested operation.');
    }
    return { managed: await observe(marker, input.worktreePath) };
  }

  async function removeManagedWorktree(input: GitOperationOptions<'removeManagedWorktree'>) {
    const { managed } = await inspectManagedWorktree(input);
    if (!managed || managed.repositoryIdentity !== input.expectedRepositoryIdentity
      || managed.worktreeIdentity !== input.expectedWorktreeIdentity || managed.head !== input.expectedHead
      || managed.branch !== input.expectedBranch || managed.dirty) conflict('Managed removal identity, head or cleanliness changed.');
    input.signal?.throwIfAborted();
    try {
      // Retains the branch and marker so cleanup cannot discard the observed commit or reuse its ownership identity.
      await runExactGit(input.projectPath, ['worktree', 'remove', '--', input.worktreePath]);
      await absent(input.worktreePath);
      const registered = (await gitValue(input.projectPath, ['worktree', 'list', '--porcelain', '-z'])).split('\0');
      if (registered.includes(`worktree ${input.worktreePath}`)) throw new Error('Managed worktree remains registered.');
      return { success: true as const, removed: managed };
    } catch { throw new GitServiceError('GIT_MUTATION_OUTCOME_UNKNOWN', 'Managed removal could not be confirmed; never retry by path alone.'); }
  }

  return { createManagedWorktree, inspectManagedWorktree, removeManagedWorktree };
}
