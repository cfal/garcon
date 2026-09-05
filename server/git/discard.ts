import { promises as fs } from 'fs';
import { GitDomainError } from './git-types.js';
import { literalGitPathspec } from './pathspecs.js';
import { parsePorcelainV1Z, UNMERGED_STATUSES } from './porcelain-status.js';
import {
  assertGitRepository,
  readOnlyGitOptions,
  resolvePathWithinProject,
  runGit,
} from './run.js';
import type { FileOptions } from './types.js';

async function headHasPath(projectPath: string, file: string): Promise<boolean> {
  // ls-tree reports a path HEAD lacks as a successful empty result, so any
  // command failure stays a real error instead of masquerading as absence
  // and skipping the worktree restore. The literal pathspec keeps a file
  // named like a glob from matching every path HEAD holds.
  const { stdout } = await runGit(
    projectPath,
    ['ls-tree', '-z', 'HEAD', '--', literalGitPathspec(file)],
    readOnlyGitOptions(),
  );
  return stdout.length > 0;
}

export async function discard({ projectPath, file }: FileOptions): Promise<unknown> {
  await assertGitRepository(projectPath);

  const { stdout: rootOutput } = await runGit(
    projectPath,
    ['rev-parse', '--show-toplevel', '--show-prefix'],
    readOnlyGitOptions(),
  );
  const [rootLine = '', prefixLine = ''] = rootOutput.split('\n');
  const repoRoot = rootLine || projectPath;
  const projectPrefix = prefixLine;
  const canonicalFile = `${projectPrefix}${file.replace(/\/+$/, '')}`;

  const { stdout: statusOutput } = await runGit(
    repoRoot,
    ['status', '--porcelain=v1', '-z', '-uall'],
    readOnlyGitOptions(),
  );
  // The global read keeps rename entries intact: a destination-only
  // pathspec cannot pair the rename and reports DA, hiding the source path
  // that the worktree side of the change spans. An exact path match wins,
  // because a copy source keeps an entry of its own; the rename-source
  // fallback is rename-only, since a copy source is not an alias for its
  // destination and discarding it must not touch the copy. Untracked
  // directories expand to their files under -uall, so a directory-shaped
  // request only matches when it names a nested repository.
  const entries = parsePorcelainV1Z(statusOutput);
  const entry = entries.find(
    (candidate) => candidate.path.replace(/\/+$/, '') === canonicalFile,
  ) ?? entries.find(
    (candidate) =>
      candidate.originalPath === canonicalFile
      && candidate.workTreeStatus === 'R',
  );
  if (!entry) {
    throw new GitDomainError('INVALID_INPUT', 'No local working-tree changes were found for this file.');
  }
  const status = `${entry.indexStatus}${entry.workTreeStatus}`;

  if (status === '??') {
    const filePath = resolvePathWithinProject(projectPath, file);
    const stats = await fs.stat(filePath);
    if (stats.isDirectory()) {
      await fs.rm(filePath, { recursive: true, force: true });
    } else {
      await fs.unlink(filePath);
    }
  } else if (entry.workTreeStatus === 'R' || entry.workTreeStatus === 'C') {
    // A rename or copy destination is an intent-to-add entry, so it resets
    // instead of restoring: the index side of an intent-to-add is the empty
    // blob and restore would truncate the worktree copy. Reset keeps that
    // content: untracked when HEAD lacks the destination, or compared
    // against HEAD's version when HEAD has it - a destination HEAD tracks
    // with different worktree content intentionally lands as a modification
    // rather than losing the never-hashed bytes. A rename additionally
    // restores the source the rename removed from the worktree; a copy
    // leaves its source in place, and restoring that path would erase the
    // source's own unstaged edits, so only the destination resets.
    if (entry.workTreeStatus === 'R' && entry.originalPath) {
      await runGit(repoRoot, ['restore', '--', literalGitPathspec(entry.originalPath)]);
    }
    await runGit(repoRoot, ['reset', 'HEAD', '--', literalGitPathspec(entry.path)]);
  } else if (UNMERGED_STATUSES.has(status)) {
    // Conflicts resolve against HEAD: reset clears the stages, and restore
    // rewrites the worktree to HEAD's version only when HEAD has the path
    // (it does for UU/UD/AA and an ours-added AU). When HEAD lacks the path
    // (DD/DU/UA) reset leaves any worktree leftover untracked.
    await runGit(repoRoot, ['reset', 'HEAD', '--', literalGitPathspec(entry.path)]);
    if (await headHasPath(repoRoot, entry.path)) {
      await runGit(repoRoot, ['restore', '--', literalGitPathspec(entry.path)]);
    }
  } else if (status === 'A ' || entry.workTreeStatus === 'A') {
    // The workbench only offers discard on unstaged changes, so AM/AD/AT land
    // in the restore branch below and keep their staged addition. Reset
    // remains for index-only additions (endpoint-reachable, no worktree
    // changes to restore) and for an unstaged A column, which marks an
    // intent-to-add entry whose worktree content HEAD does not track: reset
    // drops the index entry and preserves the copy as untracked.
    await runGit(repoRoot, ['reset', 'HEAD', '--', literalGitPathspec(entry.path)]);
  } else if (entry.workTreeStatus !== ' ' && 'MDT'.includes(entry.workTreeStatus)) {
    // Unstaged modifications, deletions, and typechanges revert the worktree
    // to the index, keeping any staged facet: AT lands back at a staged
    // addition once restore rewrites the worktree entry to the indexed
    // type. Staged-only states ('M ', 'D ', 'T ') have no worktree side to
    // discard and fall through as no-ops.
    await runGit(repoRoot, ['restore', '--', literalGitPathspec(entry.path)]);
  }

  return { success: true, message: `Changes discarded for ${file}` };
}
