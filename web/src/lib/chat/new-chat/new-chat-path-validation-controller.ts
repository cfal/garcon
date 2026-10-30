import { validateStart, type ValidateStartErrorCode } from '$lib/api/chats.js';
import type { PathValidationStatus } from './new-chat-submit.js';
import type { NewChatPreambleSelectionState } from '$lib/preambles/new-chat-preamble-selection-state.svelte.js';
import * as m from '$lib/paraglide/messages.js';

interface NewChatPathValidationForm {
	readonly nonblankPath: string;
	readonly executorId: string;
	readonly pathContextKey: string;
	validationStatus: PathValidationStatus;
	validationError: string | null;
	gitRepoStatus: 'unknown' | 'git' | 'non-git';
	readonly preambles: Pick<
		NewChatPreambleSelectionState,
		'pathValidationStarted' | 'invalidatePreview' | 'refreshPreview'
	>;
}

export class NewChatPathValidationController {
	#validationTimer: ReturnType<typeof setTimeout> | null = null;
	#validationRequestVersion = 0;
	#validationTargetKey: string | null = null;
	readonly #form: NewChatPathValidationForm;

	constructor(form: NewChatPathValidationForm) {
		this.#form = form;
	}

	validateSelectedPath(): void {
		const validate = this.#preparePathValidation();
		if (validate) void validate();
	}

	validateChangedPath(): void {
		if (this.#validationTargetKey === this.#currentValidationTargetKey) return;
		this.validatePath();
	}

	get #currentValidationTargetKey(): string {
		return `${this.#form.pathContextKey}\u0000${this.#form.nonblankPath}`;
	}

	/** Debounced validation of the project path against the server. */
	validatePath(): void {
		const validate = this.#preparePathValidation();
		if (validate) this.#validationTimer = setTimeout(() => void validate(), 300);
	}

	#preparePathValidation(): (() => Promise<void>) | null {
		const path = this.#form.nonblankPath;
		const executorId = this.#form.executorId;
		const contextKey = this.#form.pathContextKey;
		if (!path) {
			this.clear();
			return null;
		}

		this.#form.preambles.pathValidationStarted();

		this.#form.validationStatus = 'checking';
		this.#form.validationError = null;

		if (this.#validationTimer) clearTimeout(this.#validationTimer);
		this.#validationTimer = null;
		this.#validationTargetKey = this.#currentValidationTargetKey;
		const requestVersion = ++this.#validationRequestVersion;
		const current = () =>
			requestVersion === this.#validationRequestVersion &&
			contextKey === this.#form.pathContextKey &&
			executorId === this.#form.executorId &&
			path === this.#form.nonblankPath;

		return async () => {
			this.#validationTimer = null;
			try {
				const data = await validateStart(path, { executorId });
				if (!current()) return;
				if (data.valid) {
					this.#form.validationStatus = 'valid';
					this.#form.validationError = null;
					this.#form.gitRepoStatus = data.isGitRepo ? 'git' : 'non-git';
					void this.#form.preambles.refreshPreview();
				} else {
					this.#form.validationStatus = 'invalid';
					this.#form.validationError = this.#validationErrorMessage(data.errorCode);
					this.#form.gitRepoStatus = 'non-git';
					this.#form.preambles.invalidatePreview();
				}
			} catch (err) {
				if (!current()) return;
				this.#form.validationStatus = 'invalid';
				this.#form.validationError =
					err instanceof Error ? err.message : m.chat_new_chat_errors_invalid_directory();
				this.#form.gitRepoStatus = 'non-git';
				this.#form.preambles.invalidatePreview();
				console.warn('[NewChatPathValidationController] Path validation request failed', err);
			}
		};
	}

	#validationErrorMessage(errorCode?: ValidateStartErrorCode): string {
		if (errorCode === 'outside_base_dir') return m.chat_new_chat_errors_path_outside_base_dir();
		if (errorCode === 'path_not_found') return m.chat_new_chat_errors_path_not_found();
		if (errorCode === 'permission_denied') return m.chat_new_chat_errors_path_permission_denied();
		if (errorCode === 'not_directory') return m.chat_new_chat_errors_path_not_directory();
		return m.chat_new_chat_errors_invalid_directory();
	}

	clear(): void {
		this.#validationTargetKey = null;
		if (this.#validationTimer) {
			clearTimeout(this.#validationTimer);
			this.#validationTimer = null;
		}
		this.#validationRequestVersion += 1;
		this.#form.validationStatus = 'idle';
		this.#form.validationError = null;
		this.#form.gitRepoStatus = 'unknown';
		this.#form.preambles.invalidatePreview();
	}

	dispose(): void {
		if (this.#validationTimer) clearTimeout(this.#validationTimer);
		this.#validationTimer = null;
		this.#validationRequestVersion += 1;
		this.#form.preambles.invalidatePreview();
	}
}
