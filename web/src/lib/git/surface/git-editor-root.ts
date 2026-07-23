export interface GitEditorRootInput {
	activeProjectPath: string;
	targetRepoRoot?: string | null;
	activeView: 'changes' | 'history' | 'comparison';
	comparisonRepoRoot?: string | null;
}

export function resolveGitEditorRoot(input: GitEditorRootInput): string {
	if (input.activeView === 'comparison') {
		return input.comparisonRepoRoot ?? input.targetRepoRoot ?? input.activeProjectPath;
	}
	return input.targetRepoRoot ?? input.activeProjectPath;
}
