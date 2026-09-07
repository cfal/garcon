import {
	preambleSelectionPreview,
	type PreambleSelectionPreviewResponse,
} from '$lib/api/chat-preambles.js';
import type { PathValidationStatus } from '$lib/chat/new-chat/new-chat-submit.js';
import { normalizeTags } from '$lib/utils/tags.js';
import type { AgentId } from '$shared/agents';
import type { PreambleId, PreambleSelectionProjection } from '$shared/preambles';

export type NewChatPreambleChoice =
	| { readonly mode: 'defaults' }
	| { readonly mode: 'explicit'; readonly orderedPreambleIds: readonly PreambleId[] };

interface NewChatPreambleSelectionStateOptions {
	readonly trimmedPath: string;
	readonly validationStatus: PathValidationStatus;
	readonly agentId: AgentId;
	readonly chatTags: readonly string[];
}

export class NewChatPreambleSelectionState {
	choice = $state<NewChatPreambleChoice>({ mode: 'defaults' });
	preview = $state<PreambleSelectionProjection | null>(null);
	previewLoading = $state(false);
	canonicalProjectPath = $state('');

	#previewVersion = 0;
	#choiceVersion = 0;
	#previewSourceContext = '';

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
		const context = this.#previewContext();
		this.#previewVersion += 1;
		if (
			this.options.validationStatus === 'invalid' ||
			(this.#previewSourceContext !== '' && context.key !== this.#previewSourceContext)
		) {
			this.#clearPreview();
		}
	}

	automaticFiltersChanged(): void {
		if (this.choice.mode === 'explicit') return;
		this.#refreshForCurrentContext();
	}

	catalogChanged(): void {
		this.#refreshForCurrentContext();
	}

	invalidatePreview(): void {
		this.#previewVersion += 1;
		this.#clearPreview();
	}

	async refreshPreview(): Promise<void> {
		const context = this.#previewContext();
		const projectPath = context.projectPath;
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
				agentId: context.agentId,
				tags: context.tags,
				...this.creationFields,
			});
			if (!this.#isCurrentPreview(version, choiceVersion, context.key)) return;
			this.preview = preview.projection;
			this.canonicalProjectPath = preview.canonicalProjectPath;
			this.#previewSourceContext = context.key;
		} catch {
			if (!this.#isCurrentPreview(version, choiceVersion, context.key)) return;
			this.#clearPreview();
		} finally {
			if (version === this.#previewVersion) this.previewLoading = false;
		}
	}

	reset(): void {
		this.choice = { mode: 'defaults' };
		this.#choiceVersion += 1;
		this.#refreshForCurrentContext();
	}

	#clearPreview(): void {
		this.preview = null;
		this.previewLoading = false;
		this.canonicalProjectPath = '';
		this.#previewSourceContext = '';
	}

	#refreshForCurrentContext(): void {
		this.invalidatePreview();
		if (this.options.validationStatus === 'valid') void this.refreshPreview();
	}

	#previewContext(): {
		readonly projectPath: string;
		readonly agentId: AgentId;
		readonly tags: readonly string[];
		readonly key: string;
	} {
		const projectPath = this.options.trimmedPath;
		const agentId = this.options.agentId;
		const tags = normalizeTags(this.options.chatTags);
		const key =
			this.choice.mode === 'defaults'
				? `${projectPath}\u0000${agentId}\u0000${tags.join('\u0000')}`
				: `${projectPath}\u0000explicit`;
		return {
			projectPath,
			agentId,
			tags,
			key,
		};
	}

	#isCurrentPreview(version: number, choiceVersion: number, contextKey: string): boolean {
		return (
			version === this.#previewVersion &&
			choiceVersion === this.#choiceVersion &&
			contextKey === this.#previewContext().key
		);
	}
}
