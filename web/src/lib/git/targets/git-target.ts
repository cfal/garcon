import type { GitTargetCandidate } from '$lib/api/git.js';
import type { GitProjectTarget } from '$shared/git-execution';

export interface GitTarget extends GitProjectTarget {
	repoRoot: string;
	worktreePath: string;
	label: string;
	branch?: string;
	source: GitTargetCandidate['source'];
}

export function sameGitProject(
	left: GitProjectTarget | null,
	right: GitProjectTarget | null,
): boolean {
	return left?.executorId === right?.executorId && left?.projectPath === right?.projectPath;
}

export function gitProjectKey(project: GitProjectTarget): string {
	return JSON.stringify([project.executorId, project.projectPath]);
}

export function gitTargetFromCandidate(candidate: GitTargetCandidate, executorId: string): GitTarget {
	return {
		executorId,
		projectPath: candidate.projectPath,
		repoRoot: candidate.repoRoot,
		worktreePath: candidate.worktreePath,
		label: candidate.label,
		branch: candidate.branch,
		source: candidate.source,
	};
}

export function gitTargetIdentity(effectiveProjectKey: string, target: GitTarget): string {
	return JSON.stringify([target.executorId, effectiveProjectKey, target.repoRoot, target.worktreePath]);
}

export function gitTargetCandidateFromTarget(target: GitTarget): GitTargetCandidate {
	return {
		...target,
		branch: target.branch ?? '',
		isCurrent: true,
		isMissing: false,
	};
}
