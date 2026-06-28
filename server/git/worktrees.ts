import path from 'path';
import { promises as fs } from 'fs';
import type {
  CreateWorktreeOptions,
  ProjectOptions,
  RemoveWorktreeOptions,
  RepoInfo,
  TargetCandidate,
  WorktreeInfo,
} from './types.js';
import { assertGitRepository, readOnlyGitOptions, runGit } from './run.js';

export function createWorktreeOperations() {
  // Lightweight git capability probe. Reports whether a path is inside a
  // git repository and, if so, the repository root and current worktree path.
  async function getRepoInfo({ projectPath }: ProjectOptions): Promise<RepoInfo> {
    try {
      await fs.access(projectPath);
    } catch {
      return { isGitRepository: false };
    }

    try {
      const { stdout: topLevelOut } = await runGit(
        projectPath,
        ['rev-parse', '--show-toplevel'],
        readOnlyGitOptions(),
      );
      const repoRoot = topLevelOut.trim();

      // --show-toplevel gives the worktree root, which equals projectPath
      // when the user points at a worktree directory directly.
      return {
        isGitRepository: true,
        repoRoot,
        currentWorktreePath: repoRoot,
      };
    } catch {
      return { isGitRepository: false };
    }
  }

  async function getWorktrees({ projectPath }: ProjectOptions): Promise<{ worktrees: WorktreeInfo[] }> {
    await assertGitRepository(projectPath);

    const { stdout } = await runGit(
      projectPath,
      ['worktree', 'list', '--porcelain'],
      readOnlyGitOptions(),
    );
    const worktrees: WorktreeInfo[] = [];
    let current: WorktreeInfo | null = null;

    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current) worktrees.push(current);
        current = { path: line.substring(9), branch: '', name: '', isCurrent: false, isMain: false, isPathMissing: false };
      } else if (line.startsWith('HEAD ') && current) {
        // HEAD hash, skip
      } else if (line.startsWith('branch ') && current) {
        const ref = line.substring(7);
        current.branch = ref.replace('refs/heads/', '');
        current.name = current.branch;
      } else if (line === 'bare' && current) {
        current.isMain = true;
        current.name = current.name || path.basename(current.path);
      } else if (line === 'detached' && current) {
        current.branch = '(detached)';
        current.name = current.name || path.basename(current.path);
      }
    }
    if (current) worktrees.push(current);

    const resolvedProject = path.resolve(projectPath);
    for (const wt of worktrees) {
      const resolvedWt = path.resolve(wt.path);
      if (resolvedWt === resolvedProject) wt.isCurrent = true;
      if (!wt.name) wt.name = path.basename(wt.path);
      try {
        await fs.access(wt.path);
      } catch {
        wt.isPathMissing = true;
      }
    }
    if (worktrees.length > 0) worktrees[0].isMain = true;

    return { worktrees };
  }

  async function getTargetCandidates({ projectPath }: ProjectOptions): Promise<{ targets: TargetCandidate[] }> {
    await assertGitRepository(projectPath);

    const repoInfo = await getRepoInfo({ projectPath });
    const { worktrees } = await getWorktrees({ projectPath });
    const targets: TargetCandidate[] = [];
    const seen = new Set<string>();

    function addTarget(target: TargetCandidate): void {
      if (!target.worktreePath || seen.has(target.worktreePath)) return;
      seen.add(target.worktreePath);
      targets.push(target);
    }

    // The chat-project target shares the current worktree's path, so the
    // dedup below drops the matching worktree entry. Carry its branch onto
    // the chat-project candidate so the toolbar shows the branch on first
    // paint without a separate status request.
    const chatProjectWorktreePath = repoInfo.currentWorktreePath || projectPath;
    const resolvedChatProjectWorktreePath = path.resolve(chatProjectWorktreePath);
    const currentWorktree =
      worktrees.find((wt) => wt.isCurrent) ??
      worktrees.find((wt) => path.resolve(wt.path) === resolvedChatProjectWorktreePath);

    addTarget({
      projectPath,
      repoRoot: repoInfo.repoRoot || projectPath,
      worktreePath: chatProjectWorktreePath,
      label: path.basename(projectPath) || projectPath,
      branch: currentWorktree?.branch ?? '',
      source: 'chat-project',
      isCurrent: true,
      isMissing: false,
    });

    for (const wt of worktrees) {
      addTarget({
        projectPath: wt.path,
        repoRoot: repoInfo.repoRoot || projectPath,
        worktreePath: wt.path,
        label: `${wt.name || path.basename(wt.path)}${wt.branch ? ` (${wt.branch})` : ''}`,
        branch: wt.branch,
        source: 'worktree',
        isCurrent: wt.isCurrent,
        isMissing: wt.isPathMissing,
      });
    }

    return { targets };
  }

  async function createWorktree({
    projectPath,
    baseRef,
    worktreePath,
    branch,
    detach,
  }: CreateWorktreeOptions): Promise<unknown> {
    await assertGitRepository(projectPath);

    const args: string[] = ['worktree', 'add'];
    if (detach) {
      args.push('--detach', worktreePath);
      if (baseRef) args.push(baseRef);
    } else if (branch) {
      // Check if the branch already exists to avoid `-b` failure.
      const branchExists = await runGit(
        projectPath,
        ['rev-parse', '--verify', `refs/heads/${branch}`],
        readOnlyGitOptions(),
      )
        .then(() => true)
        .catch(() => false);
      if (branchExists) {
        // Checkout existing branch into the new worktree path.
        args.push(worktreePath, branch);
      } else {
        args.push('-b', branch, worktreePath);
        if (baseRef) args.push(baseRef);
      }
    } else {
      args.push(worktreePath);
      if (baseRef) args.push(baseRef);
    }

    const { stdout } = await runGit(projectPath, args);
    const resolvedPath = path.resolve(projectPath, worktreePath);
    return { success: true, output: stdout || 'Worktree created', worktreePath: resolvedPath };
  }

  async function removeWorktree({ projectPath, worktreePath, force }: RemoveWorktreeOptions): Promise<unknown> {
    await assertGitRepository(projectPath);

    const args: string[] = ['worktree', 'remove'];
    if (force) args.push('--force');
    args.push(worktreePath);

    const { stdout } = await runGit(projectPath, args);
    return { success: true, output: stdout || 'Worktree removed' };
  }


  return {
    getRepoInfo,
    getWorktrees,
    getTargetCandidates,
    createWorktree,
    removeWorktree,
  };
}
