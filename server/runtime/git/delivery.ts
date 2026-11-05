import { lstat } from 'node:fs/promises';
import { isCredentialFreeGitRemoteUrl, type CommitIdentity } from '../../../common/git-delivery.js';
import { GitServiceError } from '../../../common/git-error.js';
import { isGitObjectId } from '../../../common/git-managed-worktrees.js';
import { isGitCancellation } from './operation-context.js';
import { assertSafeRemoteName } from './ref-validation.js';
import { readOnlyGitOptions } from './run.js';
import { requireCompleteGitHistory, requireExactCommit, runExactGit } from './exact-objects.js';
import { hasNodeErrorCode } from '../../common/errors.js';
import type { GitOperationOptions } from './types.js';

function reject(message: string): never { throw new GitServiceError('GIT_INVALID_INPUT', message); }

async function value(projectPath: string, args: string[]): Promise<string> {
  return (await runExactGit(projectPath, args, readOnlyGitOptions({ maxStdoutBytes: 64 * 1024 }))).stdout.replace(/\r?\n$/, '');
}

async function optionalValue(projectPath: string, args: string[]): Promise<string> {
  try { return await value(projectPath, args); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 1 && !isGitCancellation(error)) return '';
    throw error;
  }
}

async function remoteUrl(projectPath: string, remote: string, expected: string, direction: 'fetch' | 'push'): Promise<string> {
  assertSafeRemoteName(remote);
  if (!isCredentialFreeGitRemoteUrl(expected)) reject('Remote destinations must not contain embedded credentials.');
  const urls = await value(projectPath, ['remote', 'get-url', ...(direction === 'push' ? ['--push'] : []), '--all', remote]);
  if (!isCredentialFreeGitRemoteUrl(urls) || urls !== expected) reject('Remote destination changed, contains credentials, or has multiple URLs.');
  if ((await value(projectPath, ['remote'])).split('\n').includes(urls)) reject('Remote destination is ambiguous with a configured remote name.');
  if (!/[\/\\]/.test(urls)) {
    for (const directory of ['remotes', 'branches']) {
      const path = await value(projectPath, ['rev-parse', '--path-format=absolute', '--git-path', `${directory}/${urls}`]);
      try { await lstat(path); }
      catch (error) { if (hasNodeErrorCode(error, 'ENOENT')) continue; throw error; }
      reject('Remote destination is ambiguous with a legacy remote name.');
    }
  }
  if (direction === 'push' && await optionalValue(projectPath, ['config', '--bool', '--get', `remote.${remote}.mirror`]) === 'true') {
    reject('Exact pushes do not support mirror remotes.');
  }
  if (direction === 'push' && await optionalValue(projectPath, ['config', '--null', '--get', `remote.${remote}.vcs`])) {
    reject('Exact pushes do not support remote-helper overrides.');
  }
  const rewrites = await optionalValue(projectPath, ['config', '--null', '--get-regexp', '^url\\..*\\.insteadof$']);
  for (const entry of rewrites.split('\0').filter(Boolean)) {
    const separator = entry.indexOf('\n');
    if (separator < 0 || urls.startsWith(entry.slice(separator + 1))) reject('Resolved remote destination would be rewritten again.');
  }
  return urls;
}

async function exactRef(projectPath: string, ref: string): Promise<void> {
  if (!ref.startsWith('refs/')) reject('A fully qualified ref is required.');
  await runExactGit(projectPath, ['check-ref-format', ref], readOnlyGitOptions());
}

async function remoteCommit(projectPath: string, url: string, ref: string): Promise<string | null> {
  // Protocol v2 advertises non-HEAD symrefs; other transports still require trusted administration of direct refs.
  const output = await value(projectPath, ['-c', 'protocol.version=2', 'ls-remote', '--symref', '--refs', '--', url, ref]);
  if (!output) return null;
  const lines = output.split('\n');
  if (lines.some(line => line.startsWith('ref: '))) reject('Exact transfer requires a direct remote ref.');
  const [commit, observedRef] = lines[0]!.split('\t');
  if (lines.length !== 1 || observedRef !== ref || !isGitObjectId(commit)) reject('Remote ref observation was not exact.');
  return commit;
}

export function createDeliveryOperations() {
  async function inspectCommit(input: GitOperationOptions<'inspectCommit'>): Promise<CommitIdentity> {
    await requireCompleteGitHistory(input.projectPath);
    await requireExactCommit(input.projectPath, input.commit);
    if (input.ancestor) await requireExactCommit(input.projectPath, input.ancestor);
    const metadata = await value(input.projectPath, ['cat-file', 'commit', input.commit]);
    const headers = metadata.split('\n\n', 1)[0]!.split('\n');
    const tree = headers[0]?.startsWith('tree ') ? headers[0].slice(5) : null;
    const parents: string[] = [];
    let index = 1;
    while (headers[index]?.startsWith('parent ')) parents.push(headers[index++]!.slice(7));
    if (headers.slice(index).some(line => line.startsWith('parent ') || line.startsWith('tree '))) reject('Commit identity headers are not canonical.');
    if (!isGitObjectId(tree) || parents.length > 256 || !parents.every(isGitObjectId)) reject('Commit metadata exceeds the supported bounds.');
    let containsAncestor: boolean | null = null;
    if (input.ancestor) {
      try {
        await value(input.projectPath, ['merge-base', '--is-ancestor', input.ancestor, input.commit]);
        containsAncestor = true;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 1 && !isGitCancellation(error)) containsAncestor = false;
        else throw error;
      }
    }
    return { commit: input.commit, tree, parents, containsAncestor };
  }

  async function fetchExactRef(input: GitOperationOptions<'fetchExactRef'>) {
    await requireCompleteGitHistory(input.projectPath);
    await exactRef(input.projectPath, input.ref);
    const url = await remoteUrl(input.projectPath, input.remote, input.expectedRemoteUrl, 'fetch');
    if (await remoteCommit(input.projectPath, url, input.ref) !== input.commit) reject('Remote ref no longer names the expected commit.');
    await remoteUrl(input.projectPath, input.remote, input.expectedRemoteUrl, 'fetch');
    try {
      // An explicit source-only refspec supports advertised-ref servers without moving local refs.
      await runExactGit(input.projectPath, ['-c', 'fetch.bundleURI=', 'fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules',
        '--refmap=', '--', url, input.ref]);
      await requireExactCommit(input.projectPath, input.commit);
      if (await remoteCommit(input.projectPath, url, input.ref) !== input.commit) reject('Remote ref changed during transfer.');
      await remoteUrl(input.projectPath, input.remote, input.expectedRemoteUrl, 'fetch');
      return { success: true as const, ref: input.ref, commit: input.commit };
    } catch {
      throw new GitServiceError('GIT_MUTATION_OUTCOME_UNKNOWN', 'Exact fetch could not be confirmed. Inspect the expected commit before continuing.');
    }
  }

  async function pushExactRef(input: GitOperationOptions<'pushExactRef'>) {
    await requireCompleteGitHistory(input.projectPath);
    await exactRef(input.projectPath, input.ref);
    await requireExactCommit(input.projectPath, input.commit);
    const url = await remoteUrl(input.projectPath, input.remote, input.expectedRemoteUrl, 'push');
    if (await remoteCommit(input.projectPath, url, input.ref) !== input.expectedRemoteCommit) reject('Remote ref changed before push.');
    await remoteUrl(input.projectPath, input.remote, input.expectedRemoteUrl, 'push');
    try {
      await runExactGit(input.projectPath, ['-c', 'push.followTags=false', '-c', 'push.pushOption=', 'push', '--porcelain',
        '--recurse-submodules=no', `--force-with-lease=${input.ref}:${input.expectedRemoteCommit ?? ''}`,
        '--', input.remote, `${input.commit}:${input.ref}`]);
      if (await remoteCommit(input.projectPath, url, input.ref) !== input.commit) reject('Remote ref changed after push.');
      await remoteUrl(input.projectPath, input.remote, input.expectedRemoteUrl, 'push');
      return { success: true as const, ref: input.ref, commit: input.commit };
    } catch {
      throw new GitServiceError('GIT_MUTATION_OUTCOME_UNKNOWN', 'Exact push could not be confirmed. Reconcile the destination ref without repeating the push.');
    }
  }

  return { inspectCommit, fetchExactRef, pushExactRef };
}
