import type { GitTargetCandidate } from '$lib/api/git.js';

export interface GitTarget {
	projectPath: string;
	repoRoot: string;
	worktreePath: string;
	label: string;
	branch?: string;
	source: GitTargetCandidate['source'];
}

export function gitTargetFromCandidate(candidate: GitTargetCandidate): GitTarget {
	return {
		projectPath: candidate.projectPath,
		repoRoot: candidate.repoRoot,
		worktreePath: candidate.worktreePath,
		label: candidate.label,
		branch: candidate.branch,
		source: candidate.source,
	};
}

export function gitTargetIdentity(effectiveProjectKey: string, target: GitTarget): string {
	return JSON.stringify([effectiveProjectKey, target.repoRoot, target.worktreePath]);
}

export function gitTargetCandidateFromTarget(target: GitTarget): GitTargetCandidate {
	return {
		...target,
		branch: target.branch ?? '',
		isCurrent: true,
		isMissing: false,
	};
}
