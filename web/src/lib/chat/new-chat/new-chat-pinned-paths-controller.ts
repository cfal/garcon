import type { NewChatFormState } from './new-chat-form-state.svelte';
import type { ExecutorsStore } from '$lib/executors/executors-store.svelte';
import type { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte';
import { executorPinnedPathGroups } from '$lib/project-paths/executor-pinned-paths';
import { executorPinnedProjectPaths } from '$lib/project-paths/pinned-project-path-settings';

type PinnedPathForm = Pick<
	NewChatFormState,
	| 'executorId'
	| 'pinnedProjectPaths'
	| 'isUpdatingPinnedPath'
	| 'selectExecutor'
	| 'projectPath'
	| 'showBrowser'
	| 'clearError'
	| 'validatePath'
>;

export class NewChatPinnedPathsController {
	constructor(
		private readonly getForm: () => PinnedPathForm,
		private readonly executors: Pick<ExecutorsStore, 'executors' | 'isReady'>,
		private readonly settings: Pick<RemoteSettingsStore, 'snapshot'>,
	) {}

	get groups() {
		const form = this.getForm();
		return executorPinnedPathGroups(
			this.settings.snapshot?.paths,
			this.executors.executors,
			form.executorId,
			form.pinnedProjectPaths,
		);
	}

	select(executorId: string, path: string): boolean {
		const form = this.getForm();
		if (form.isUpdatingPinnedPath || !this.executors.isReady(executorId)) return false;
		const paths =
			executorId === form.executorId
				? form.pinnedProjectPaths
				: executorPinnedProjectPaths(this.settings.snapshot, executorId);
		if (!path.trim() || !paths.includes(path)) return false;
		form.selectExecutor(executorId);
		form.projectPath = path;
		form.showBrowser = false;
		form.clearError();
		form.validatePath();
		return true;
	}
}
