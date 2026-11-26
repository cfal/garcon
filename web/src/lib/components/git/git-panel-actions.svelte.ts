import { untrack } from 'svelte';
import { getFileSessions } from '$lib/context';
import { gitProjectInvalidations } from '$lib/git/surface/git-project-invalidation.svelte.js';
import { resolveGitEditorRoot } from '$lib/git/surface/git-editor-root.js';
import type { GitTarget } from '$lib/git/targets/git-target.js';
import type { WorkspaceWindowId } from '$lib/workspace/surface-types.js';

export function observeGitPanelInvalidation(
	isVisible: () => boolean,
	controller: () => {
		target: { effectiveProjectKey: string | null; executorId: string };
		refreshForInvalidation: (key: string, version: number) => Promise<boolean>;
	},
): void {
	$effect(() => {
		if (!isVisible()) return;
		const owner = controller();
		const key = owner.target.effectiveProjectKey;
		if (!key) return;
		const version = gitProjectInvalidations.version(owner.target.executorId);
		untrack(() => void owner.refreshForInvalidation(key, version));
	});
}

export function createGitPanelEditorAction(options: {
	projectPath: () => string | null;
	target: () => GitTarget | null;
	presentation: () => WorkspaceWindowId | 'mobile';
	reviewRepoRoot?: () => string | null | undefined;
}): (relativePath: string, line: number) => void {
	const fileSessions = getFileSessions();
	return (relativePath, line) => {
		const target = options.target();
		const projectPath = options.projectPath();
		if (!target || !projectPath) return;
		void fileSessions.open({
			executorId: target.executorId,
			fileRootPath: resolveGitEditorRoot({
				activeProjectPath: projectPath,
				targetRepoRoot: target.repoRoot,
				reviewRepoRoot: options.reviewRepoRoot?.(),
			}),
			relativePath,
			mode: 'code',
			origin: options.presentation(),
			reason: 'user-open',
			line,
		});
	};
}
