import {
	preambleSelectionPreview,
	type PreambleSelectionPreviewResponse,
} from '$lib/api/chat-preambles.js';
import type { PathValidationStatus } from '$lib/chat/new-chat/new-chat-submit.js';
import type { PreambleId, PreambleSelectionProjection } from '$shared/preambles';

export type NewChatPreambleChoice =
	| { readonly mode: 'defaults' }
	| { readonly mode: 'explicit'; readonly orderedPreambleIds: readonly PreambleId[] };

interface NewChatPreambleSelectionStateOptions {
	readonly trimmedPath: string;
	readonly validationStatus: PathValidationStatus;
}

export class NewChatPreambleSelectionState {
	choice = $state<NewChatPreambleChoice>({ mode: 'defaults' });
	preview = $state<PreambleSelectionProjection | null>(null);
	previewLoading = $state(false);
	canonicalProjectPath = $state('');

	#previewVersion = 0;
	#choiceVersion = 0;
	#previewSourcePath = '';

	constructor(private readonly options: NewChatPreambleSelectionStateOptions) {}

	get previewCount(): number {
		return this.preview?.eligiblePreambles.length ?? 0;
	}

	get configurable(): boolean {
		return this.choice.mode === 'explicit' || this.preview !== null;
	}

	get orderedIds(): readonly PreambleId[] | undefined {
		return this.choice.mode === 'explicit' ? this.choice.orderedPreambleIds : undefined;
	}

	get creationFields(): { orderedPreambleIds?: PreambleId[] } {
		return this.choice.mode === 'explicit'
			? { orderedPreambleIds: [...this.choice.orderedPreambleIds] }
			: {};
	}

	setExplicit(orderedPreambleIds: readonly PreambleId[]): void {
		this.choice = { mode: 'explicit', orderedPreambleIds: [...orderedPreambleIds] };
		this.#choiceVersion += 1;
		this.invalidatePreview();
		void this.refreshPreview();
	}

	resetToDefaults(): void {
		this.choice = { mode: 'defaults' };
		this.#choiceVersion += 1;
		this.invalidatePreview();
		void this.refreshPreview();
	}

	pathValidationStarted(): void {
		const projectPath = this.options.trimmedPath;
		this.#previewVersion += 1;
		if (
			this.options.validationStatus === 'invalid'
			|| (this.#previewSourcePath !== '' && projectPath !== this.#previewSourcePath)
		) {
			this.#clearPreview();
		}
	}

	invalidatePreview(): void {
		this.#previewVersion += 1;
		this.#clearPreview();
	}

	async refreshPreview(): Promise<void> {
		const projectPath = this.options.trimmedPath;
		if (!projectPath || this.options.validationStatus === 'invalid') {
			this.invalidatePreview();
			return;
		}

		const version = ++this.#previewVersion;
		const choiceVersion = this.#choiceVersion;
		this.previewLoading = true;

		try {
			const preview: PreambleSelectionPreviewResponse = await preambleSelectionPreview({
				projectPath,
				...this.creationFields,
			});
			if (!this.#isCurrentPreview(version, choiceVersion, projectPath)) return;
			this.preview = preview.projection;
			this.canonicalProjectPath = preview.canonicalProjectPath;
			this.#previewSourcePath = projectPath;
		} catch {
			if (!this.#isCurrentPreview(version, choiceVersion, projectPath)) return;
			this.#clearPreview();
		} finally {
			if (version === this.#previewVersion) this.previewLoading = false;
		}
	}

	reset(): void {
		this.choice = { mode: 'defaults' };
		this.#clearPreview();
		this.#previewVersion += 1;
		this.#choiceVersion += 1;
	}

	#clearPreview(): void {
		this.preview = null;
		this.previewLoading = false;
		this.canonicalProjectPath = '';
		this.#previewSourcePath = '';
	}

	#isCurrentPreview(version: number, choiceVersion: number, projectPath: string): boolean {
		return version === this.#previewVersion
			&& choiceVersion === this.#choiceVersion
			&& projectPath === this.options.trimmedPath;
	}
}
