import { isAbsolute, resolve } from 'node:path';
import type { IssueProjectDefault } from '../../common/issues.js';
import { issueProject, issueString } from '../../common/issue-validation.js';
import { readOnlyGitOptions, runGit } from '../git/run.js';
import type { GitProcessError } from '../git/types.js';
import { inspectProjectDirectory } from '../projects/project-directory-service.js';
import { IssueDomainError, validateIssueInput } from './errors.js';

interface IssueProjectResolverOptions {
  readonly inspect?: typeof inspectProjectDirectory;
  readonly git?: typeof runGit;
}

function unavailable(): IssueDomainError {
  return new IssueDomainError('ISSUE_PROJECT_UNAVAILABLE',
    'Cannot resolve the project default. Check the directory and Git configuration, or enter an explicit project.');
}

function singlePath(output: string): string {
  if (!output.endsWith('\n')) throw unavailable();
  const path = output.slice(0, -1);
  if (!isAbsolute(path)) throw unavailable();
  issueProject(path);
  return path;
}

function isNotRepository(error: unknown): boolean {
  const failure = error as GitProcessError;
  return failure.code === 128 && !failure.aborted && !failure.timedOut
    && typeof failure.stderr === 'string'
    && (failure.stderr === 'fatal: not a git repository (or any of the parent directories): .git\n'
      || /^fatal: not a git repository \(or any parent up to mount point [^\r\n]+\)\nStopping at filesystem boundary \(GIT_DISCOVERY_ACROSS_FILESYSTEM not set\)\.\n$/.test(failure.stderr));
}

function primaryCheckout(output: string): string {
  if (!output.endsWith('\0\0')) throw unavailable();
  const first = output.split('\0\0')[0]?.split('\0');
  if (!first?.[0]?.startsWith('worktree ') || !first.some((field) => field.startsWith('HEAD '))) {
    throw unavailable();
  }
  const path = first[0].slice('worktree '.length);
  if (!isAbsolute(path)) throw unavailable();
  issueProject(path);
  return path;
}

export async function resolveIssueProjectDefault(directory: string, signal?: AbortSignal,
  options: IssueProjectResolverOptions = {}): Promise<IssueProjectDefault> {
  validateIssueInput(() => issueString(directory, 'directory'));
  const inspect = options.inspect ?? inspectProjectDirectory;
  const git = options.git ?? runGit;
  const deadline = AbortSignal.timeout(5000);
  const probeSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const deadlineAt = performance.now() + 5000;
  const canonical = async (path: string): Promise<string> => {
    probeSignal.throwIfAborted();
    issueProject(path);
    const result = await inspect(path);
    probeSignal.throwIfAborted();
    if (result.kind !== 'available') throw unavailable();
    return result.effectiveProjectKey;
  };
  const probe = async (cwd: string, args: string[]): Promise<string> => {
    probeSignal.throwIfAborted();
    const result = await git(cwd, args, readOnlyGitOptions({
      signal: probeSignal, timeoutMs: Math.max(1, deadlineAt - performance.now()),
      maxStdoutBytes: 1024 * 1024, maxStderrBytes: 1024 * 1024,
      env: { LC_ALL: 'C', GIT_DIR: undefined, GIT_COMMON_DIR: undefined, GIT_WORK_TREE: undefined,
        GIT_INDEX_FILE: undefined, GIT_CEILING_DIRECTORIES: undefined },
    }));
    probeSignal.throwIfAborted();
    return result.stdout;
  };
  try {
    const cwd = await canonical(directory);
    let commonPath: string;
    try {
      commonPath = await probe(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    } catch (error) {
      if (!isNotRepository(error)) throw error;
      return { project: issueProject(cwd), kind: 'folder' };
    }
    const commonDirectory = await canonical(singlePath(commonPath));
    const mainGitDir = `--git-dir=${commonDirectory}`;
    const bare = await probe(cwd, [mainGitDir, 'rev-parse', '--is-bare-repository']);
    if (bare === 'true\n') return { project: issueProject(commonDirectory), kind: 'repository' };
    if (bare !== 'false\n') throw unavailable();
    let configuredCheckout: string | null = null;
    try {
      const configured = await probe(cwd, [mainGitDir, 'config', '--null', '--path', '--get', 'core.worktree']);
      if (!configured.endsWith('\0') || configured.slice(0, -1).includes('\0')) throw unavailable();
      configuredCheckout = resolve(commonDirectory, configured.slice(0, -1));
    } catch (error) {
      const failure = error as GitProcessError;
      if (failure.code !== 1 || failure.stdout !== '' || failure.stderr !== '' || failure.aborted || failure.timedOut) throw error;
    }
    if (configuredCheckout) {
      return { project: issueProject(await canonical(configuredCheckout)), kind: 'repository' };
    }
    const checkout = primaryCheckout(await probe(cwd, ['worktree', 'list', '--porcelain', '-z']));
    if (checkout === commonDirectory) throw unavailable();
    return { project: issueProject(await canonical(checkout)), kind: 'repository' };
  } catch {
    signal?.throwIfAborted();
    throw unavailable();
  }
}
