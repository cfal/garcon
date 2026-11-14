import type { NewChatFormState } from './new-chat-form-state.svelte';
import type { ExecutorsStore } from '$lib/executors/executors-store.svelte';
import type { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte';
import { executorPinnedPathGroups } from '$lib/project-paths/executor-pinned-paths';
import { projectPathKey } from '$lib/project-paths/project-path-key';
import { nextPinnedProjectPaths } from '$lib/project-paths/project-pinned-paths';
import { executorPinnedProjectPaths } from '$lib/project-paths/pinned-project-path-settings';
import type { RemoteSettingsSnapshot } from '$shared/settings';
import * as m from '$lib/paraglide/messages.js';
type ProjectForm = Pick<
	NewChatFormState,
	| 'executorId'
	| 'projectPath'
	| 'selectedProjectPath'
	| 'pinnedProjectPaths'
	| 'isUpdatingPinnedPath'
	| 'selectExecutor'
	| 'showBrowser'
	| 'selectProjectPath'
	| 'error'
>;

type PersistPins = (paths: string[], executorId: string) => Promise<RemoteSettingsSnapshot>;

export class NewChatProjectsController {
	#pendingPin: { executorId: string; path: string } | null = null;

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
				const selected = executorId === form.executorId ? [form.selectedProjectPath] : [];
				for (const path of [...pinned, ...recent, ...selected]) {
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
			form.executorId === executorId &&
			projectPathKey(form.selectedProjectPath) === projectPathKey(path)
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

	async togglePin(executorId: string, path: string, persist: PersistPins): Promise<boolean> {
		const form = this.getForm();
		if (form.isUpdatingPinnedPath) return false;
		if (!this.groups.some((group) => group.executorId === executorId && group.paths.includes(path)))
			return false;
		const selectedExecutorId = form.executorId;
		const previous = form.pinnedProjectPaths;
		const current =
			executorId === selectedExecutorId
				? previous
				: executorPinnedProjectPaths(this.settings.snapshot, executorId);
		const targetKey = projectPathKey(path);
		const alreadyPinned = current.some((candidate) => projectPathKey(candidate) === targetKey);
		const next = alreadyPinned
			? current.filter((candidate) => projectPathKey(candidate) !== targetKey)
			: nextPinnedProjectPaths(current, path);
		this.#pendingPin = { executorId, path };
		form.pinnedProjectPaths = executorId === selectedExecutorId ? next : previous;
		form.isUpdatingPinnedPath = true;
		form.error = null;
		try {
			const snapshot = await persist(next, executorId);
			if (executorId === form.executorId)
				form.pinnedProjectPaths = executorPinnedProjectPaths(snapshot, executorId);
			return true;
		} catch (error) {
			if (selectedExecutorId === form.executorId) form.pinnedProjectPaths = previous;
			form.error = error instanceof Error ? error.message : m.settings_save_failed();
			return false;
		} finally {
			form.isUpdatingPinnedPath = false;
			this.#pendingPin = null;
		}
	}

	isPinPending(executorId: string, path: string): boolean {
		return (
			this.getForm().isUpdatingPinnedPath &&
			this.#pendingPin?.executorId === executorId &&
			this.#pendingPin.path === path
		);
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
