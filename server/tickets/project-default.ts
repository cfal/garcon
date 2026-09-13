import { isAbsolute, resolve } from 'node:path';
import type { TicketProjectDefault } from '../../common/tickets.js';
import { ticketProject, ticketString } from '../../common/ticket-validation.js';
import { readOnlyGitOptions, runGit } from '../git/run.js';
import type { GitProcessError } from '../git/types.js';
import { inspectProjectDirectory } from '../projects/project-directory-service.js';
import { TicketDomainError, validateTicketInput } from './errors.js';

interface TicketProjectResolverOptions {
  readonly inspect?: typeof inspectProjectDirectory;
  readonly git?: typeof runGit;
}

function unavailable(): TicketDomainError {
  return new TicketDomainError('TICKET_PROJECT_UNAVAILABLE',
    'Cannot resolve the project default. Check the context directory, or enter an explicit project.');
}

function singlePath(output: string): string {
  if (!output.endsWith('\n')) throw unavailable();
  const path = output.slice(0, -1);
  if (!isAbsolute(path)) throw unavailable();
  ticketProject(path);
  return path;
}

function primaryCheckout(output: string): string {
  if (!output.endsWith('\0\0')) throw unavailable();
  const first = output.split('\0\0')[0]?.split('\0');
  if (!first?.[0]?.startsWith('worktree ') || !first.some((field) => field.startsWith('HEAD '))) {
    throw unavailable();
  }
  const path = first[0].slice('worktree '.length);
  if (!isAbsolute(path)) throw unavailable();
  ticketProject(path);
  return path;
}

export async function resolveTicketProjectDefault(directory: string, signal?: AbortSignal,
  options: TicketProjectResolverOptions = {}): Promise<TicketProjectDefault> {
  validateTicketInput(() => ticketString(directory, 'directory'));
  const inspect = options.inspect ?? inspectProjectDirectory;
  const git = options.git ?? runGit;
  const deadline = AbortSignal.timeout(5000);
  const probeSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const deadlineAt = performance.now() + 5000;
  const canonical = async (path: string): Promise<string> => {
    probeSignal.throwIfAborted();
    ticketProject(path);
    const result = await inspect(path);
    probeSignal.throwIfAborted();
    if (result.kind !== 'available') throw unavailable();
    if (ticketProject(result.effectiveProjectKey) !== result.effectiveProjectKey) throw unavailable();
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
  let cwd: string;
  try { cwd = await canonical(directory); }
  catch {
    signal?.throwIfAborted();
    throw unavailable();
  }
  try {
    const commonPath = await probe(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const commonDirectory = await canonical(singlePath(commonPath));
    const mainGitDir = `--git-dir=${commonDirectory}`;
    const bare = await probe(cwd, [mainGitDir, 'rev-parse', '--is-bare-repository']);
    if (bare === 'true\n') return { project: ticketProject(commonDirectory), kind: 'repository' };
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
      return { project: ticketProject(await canonical(configuredCheckout)), kind: 'repository' };
    }
    const checkout = primaryCheckout(await probe(cwd, ['worktree', 'list', '--porcelain', '-z']));
    if (checkout === commonDirectory) throw unavailable();
    return { project: ticketProject(await canonical(checkout)), kind: 'repository' };
  } catch {
    signal?.throwIfAborted();
    return { project: ticketProject(cwd), kind: 'folder' };
  }
}
