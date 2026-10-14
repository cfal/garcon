import type { NewChatFormState } from './new-chat-form-state.svelte';
import type { ExecutorsStore } from '$lib/executors/executors-store.svelte';
import type { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte';
import { executorPinnedPathGroups } from '$lib/project-paths/executor-pinned-paths';

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

	private get form(): PinnedPathForm {
		return this.getForm();
	}

	get groups() {
		return executorPinnedPathGroups(
			this.settings.snapshot?.paths,
			this.executors.executors,
			this.form.executorId,
			this.form.pinnedProjectPaths,
		);
	}

	select(executorId: string, path: string): void {
		if (this.form.isUpdatingPinnedPath || !this.executors.isReady(executorId)) return;
		if (!this.groups.some((group) => group.executorId === executorId && group.paths.includes(path)))
			return;
		this.form.selectExecutor(executorId);
		this.form.projectPath = path;
		this.form.showBrowser = false;
		this.form.clearError();
		this.form.validatePath();
	}
}
