export interface GitEditorRootInput {
	activeProjectPath: string;
	targetRepoRoot?: string | null;
	reviewRepoRoot?: string | null;
}

export function resolveGitEditorRoot(input: GitEditorRootInput): string {
	return input.reviewRepoRoot ?? input.targetRepoRoot ?? input.activeProjectPath;
}
