import type { NewChatFormState } from './new-chat-form-state.svelte';
import type { ExecutorsStore } from '$lib/executors/executors-store.svelte';
import type { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte';
import { executorPinnedPathGroups } from '$lib/project-paths/executor-pinned-paths';
import { projectPathKey } from '$lib/project-paths/project-path-key';
type ProjectForm = Pick<
	NewChatFormState,
	| 'executorId'
	| 'projectPath'
	| 'pinnedProjectPaths'
	| 'isUpdatingPinnedPath'
	| 'selectExecutor'
	| 'showBrowser'
	| 'selectProjectPath'
>;

export class NewChatProjectsController {
	constructor(
		private readonly getForm: () => ProjectForm,
		private readonly executors: Pick<ExecutorsStore, 'executors' | 'isReady'>,
		private readonly settings: Pick<RemoteSettingsStore, 'snapshot'>,
	) {}

	get groups() {
		const form = this.getForm();
		const paths = this.settings.snapshot?.paths;
		const pinnedGroups = executorPinnedPathGroups(
			this.settings.snapshot?.paths,
			this.executors.executors,
			form.executorId,
			form.pinnedProjectPaths,
		);
		const ids = new Set([
			'local',
			...this.executors.executors.map((executor) => executor.id),
			...Object.keys(paths?.byExecutor ?? {}),
			form.executorId,
		]);
		return [...ids]
			.map((executorId) => {
				const pinned = pinnedGroups.find((group) => group.executorId === executorId)?.paths ?? [];
				const recent =
					executorId === 'local'
						? (paths?.recentProjectPaths ?? [])
						: (paths?.byExecutor?.[executorId]?.recentPaths ?? []);
				const unique = new Map<string, string>();
				for (const path of [...pinned, ...recent]) {
					if (path.trim() && !unique.has(projectPathKey(path)))
						unique.set(projectPathKey(path), path);
				}
				return { executorId, paths: [...unique.values()] };
			})
			.filter((group) => group.paths.length > 0);
	}

	isSelected(executorId: string, path: string): boolean {
		const form = this.getForm();
		return (
			form.executorId === executorId && projectPathKey(form.projectPath) === projectPathKey(path)
		);
	}

	isPinned(executorId: string, path: string): boolean {
		const paths = this.settings.snapshot?.paths;
		const pinned =
			executorId === this.getForm().executorId
				? this.getForm().pinnedProjectPaths
				: executorId === 'local'
					? paths?.pinnedProjectPaths
					: paths?.byExecutor?.[executorId]?.pinnedPaths;
		return pinned?.some((candidate) => projectPathKey(candidate) === projectPathKey(path)) ?? false;
	}

	select(executorId: string, path: string): boolean {
		const form = this.getForm();
		if (form.isUpdatingPinnedPath || !this.executors.isReady(executorId)) return false;
		const group = this.groups.find((candidate) => candidate.executorId === executorId);
		if (!path.trim() || !group?.paths.includes(path)) return false;
		form.selectExecutor(executorId);
		form.selectProjectPath(path);
		form.showBrowser = false;
		return true;
	}
}
