import { GitDomainError } from './git-domain-error.js';
import { nulRecords } from './log-records.js';
import {
  assertGitRepository,
  readOnlyGitOptions,
  runGit
} from './run.js';
import type {
  GitStashEntry,
  ProjectOptions,
  StashCreateOptions,
  StashRefOptions
} from './types.js';


function assertSafeStashRef(stashRef: string): void {
  if (!/^stash@\{\d+\}$/.test(stashRef)) {
    throw new GitDomainError('INVALID_INPUT', 'Invalid stash ref.');
  }
}

function parseStashes(output: string): GitStashEntry[] {
  return nulRecords(output, 4, 'stash list').map(([ref, hash, date, message]) => {
    const index = /^stash@\{(\d+)\}$/.exec(ref)?.[1];
    if (index === undefined || !/^[a-f0-9]{40,64}$/.test(hash)) {
      throw new GitDomainError('INVALID_RESULT', 'Git returned an unreadable stash list.');
    }
    return { index: Number(index), ref, hash, date, message };
  });
}

// Passing --date would make git print reflog selectors as one-second timestamps, which
// collide between stashes and fail the numeric selector check in assertSafeStashRef.
async function listStashes(projectPath: string, signal?: AbortSignal): Promise<GitStashEntry[]> {
  const { stdout } = await runGit(
    projectPath,
    ['stash', 'list', '-z', '--format=%gd%x00%H%x00%ci%x00%s'],
    readOnlyGitOptions({ signal }),
  );
  return parseStashes(stdout);
}

async function getStashes({ projectPath, signal }: ProjectOptions): Promise<{ stashes: GitStashEntry[] }> {
  await assertGitRepository(projectPath);
  return { stashes: await listStashes(projectPath, signal) };
}

// Stash entries have no stable name: a numeric reflog selector moves when stashes are created
// or dropped elsewhere. Rechecking the listed commit rejects an action chosen from an older
// listing, though an external change between this check and the command remains possible.
async function listedStashSelector({ projectPath, stashRef, expectedHash, signal }: StashRefOptions): Promise<string> {
  assertSafeStashRef(stashRef);
  await assertGitRepository(projectPath);
  const current = (await listStashes(projectPath, signal)).find((stash) => stash.ref === stashRef);
  if (current?.hash !== expectedHash) {
    throw new GitDomainError(
      'STALE_STASH',
      'The stash list changed since it was loaded. Select the stash again from the current list.',
    );
  }
  return `refs/${stashRef}`;
}

async function createStash({
  projectPath,
  message,
  includeUntracked,
  signal,
}: StashCreateOptions): Promise<{ success: boolean; output: string }> {
  await assertGitRepository(projectPath);
  const args = ['stash', 'push'];
  if (includeUntracked) args.push('-u');
  if (message?.trim()) args.push('-m', message.trim());
  const { stdout } = await runGit(projectPath, args, { signal });
  return { success: true, output: stdout.trim() };
}

// Apply accepts the verified stash commit itself; Pop and Drop must name the reflog entry they remove.
async function applyStash(options: StashRefOptions): Promise<{ success: boolean }> {
  await listedStashSelector(options);
  await runGit(options.projectPath, ['stash', 'apply', options.expectedHash], { signal: options.signal });
  return { success: true };
}

async function popStash(options: StashRefOptions): Promise<{ success: boolean }> {
  const selector = await listedStashSelector(options);
  await runGit(options.projectPath, ['stash', 'pop', selector], { signal: options.signal });
  return { success: true };
}

async function dropStash(options: StashRefOptions): Promise<{ success: boolean }> {
  const selector = await listedStashSelector(options);
  await runGit(options.projectPath, ['stash', 'drop', selector], { signal: options.signal });
  return { success: true };
}

export function createStashOperations() {
  return { getStashes, createStash, applyStash, popStash, dropStash };
}
