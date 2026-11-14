import { selectDirectory } from '$lib/api/files';
import type { NewChatFormState } from '$lib/chat/new-chat/new-chat-form-state.svelte';

type FolderSelectionForm = Pick<NewChatFormState,
	'executorId' | 'worktreeContextKey' | 'nonblankPath' | 'browseStartPath' | 'projectBasePath'
	| 'filesAvailable' | 'isUpdatingPinnedPath' | 'selectProjectPath' | 'showBrowser'>;

export class NewChatFolderSelection {
	pending = $state(false);
	failed = $state(false);
	#request: AbortController | null = null;

	constructor(private readonly getForm: () => FolderSelectionForm) {}

	get form(): FolderSelectionForm { return this.getForm(); }

	cancel(): void {
		this.#request?.abort();
		this.#request = null;
		this.pending = false;
		this.failed = false;
	}

	async choose(openBrowser: () => void | Promise<void>): Promise<void> {
		if (this.pending || !this.form.filesAvailable || this.form.isUpdatingPinnedPath) return;
		const request = new AbortController();
		const executorId = this.form.executorId;
		const context = this.form.worktreeContextKey;
		const path = this.form.nonblankPath;
		const current = () => this.#request === request && !request.signal.aborted
			&& this.form.executorId === executorId && this.form.worktreeContextKey === context
			&& this.form.nonblankPath === path;
		this.#request = request;
		this.pending = true;
		this.failed = false;
		try {
			const result = await selectDirectory(executorId,
				path || this.form.browseStartPath || this.form.projectBasePath || undefined, request.signal);
			if (!current()) return;
			if (result.status === 'selected') {
				this.form.showBrowser = false;
				this.form.selectProjectPath(result.path);
			} else if (result.status === 'unsupported') {
				await openBrowser();
			}
		} catch {
			if (current()) this.failed = true;
		} finally {
			if (this.#request === request) {
				this.#request = null;
				this.pending = false;
			}
		}
	}
}
