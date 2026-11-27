import type { ScheduledSnippetExpansionContext } from '$shared/snippets';
import {
	mismatchedSnippetSources,
	type SelectableSnippet,
} from '$lib/snippets/selectable-snippet.js';
import { SnippetExpansionController } from '$lib/snippets/snippet-expansion-controller.svelte.js';
import {
	isSelectedSnippetStaleInLoadedCatalog,
	tryExpandSelectableSnippetLocally,
	type PreambleCatalogLookup,
	type SnippetCatalogLookup,
} from '$lib/snippets/local-snippet-expansion.js';
import { SnippetPaletteTriggerState } from '$lib/chat/composer/snippet-palette-trigger-state.svelte.js';
import {
	applySnippetTriggerReplacement,
	findSnippetTrigger,
} from '$lib/chat/composer/snippet-trigger.js';
import type { SnippetInsertionResult } from '$lib/chat/composer/snippet-insertion.js';
import * as m from '$lib/paraglide/messages.js';

interface Options {
	readonly snippets?: SnippetCatalogLookup | null;
	readonly preambles?: PreambleCatalogLookup | null;
	get prompt(): string;
	get context(): ScheduledSnippetExpansionContext | null;
	get interactionKey(): string;
	onInsert(text: string, caret: number): Promise<void>;
	onPendingChange(pending: boolean): void;
	onSourceChanged(source: SelectableSnippet['source']): void;
}

export class ScheduledPromptSnippets {
	readonly palette = new SnippetPaletteTriggerState();
	readonly expansion = new SnippetExpansionController();
	error = $state<string | null>(null);
	#selection = { start: 0, end: 0 };

	constructor(private readonly options: Options) {}

	open(start: number, end: number): void {
		this.#selection = { start, end };
		this.error = null;
		this.palette.openFromMenu();
	}

	detectTrigger(caret: number, prefix: string, sourceText = this.options.prompt): void {
		if (this.expansion.pending) return;
		this.error = null;
		this.palette.updateDetectedTrigger(findSnippetTrigger(sourceText, caret, prefix), sourceText);
	}

	cancel(): void {
		this.expansion.cancel();
		this.palette.reset();
		this.error = null;
		this.options.onPendingChange(false);
	}

	async insert(snippet: SelectableSnippet, argumentsText: string): Promise<SnippetInsertionResult> {
		const context = this.options.context;
		if (!context || this.expansion.pending) return 'cancelled';
		const key = this.options.interactionKey;
		const source = this.options.prompt;
		const range = this.palette.trigger ?? this.#selection;
		const argumentsInput = { type: 'value', value: argumentsText } as const;
		const insertExpanded = async (expandedText: string): Promise<'inserted'> => {
			const replacement = applySnippetTriggerReplacement(source, range, expandedText);
			this.palette.complete();
			await this.options.onInsert(replacement.text, replacement.caret);
			return 'inserted';
		};
		this.error = null;
		let pendingNotified = false;
		try {
			if (isSelectedSnippetStaleInLoadedCatalog(snippet, this.options)) {
				this.error = m.snippets_changed_before_expansion();
				this.palette.dismiss();
				return 'cancelled';
			}
			const local = tryExpandSelectableSnippetLocally(snippet, argumentsInput, {
				kind: 'scheduled',
			});
			if (local.kind === 'expanded') return await insertExpanded(local.expandedText);
			if (local.kind === 'error') {
				this.error = local.message;
				return 'failed';
			}
			pendingNotified = true;
			this.options.onPendingChange(true);
			const result = await this.expansion.run({
				shortName: snippet.shortName,
				arguments: argumentsInput,
				context,
			});
			if (
				result.kind !== 'expanded' ||
				key !== this.options.interactionKey ||
				source !== this.options.prompt
			) {
				return 'cancelled';
			}
			const staleSources = mismatchedSnippetSources(snippet, result.response);
			if (staleSources.length > 0) {
				this.error = m.snippets_changed_before_expansion();
				this.palette.dismiss();
				for (const changedSource of staleSources) {
					this.options.onSourceChanged(changedSource);
				}
				return 'cancelled';
			}
			if (isSelectedSnippetStaleInLoadedCatalog(snippet, this.options)) {
				this.error = m.snippets_changed_before_expansion();
				this.palette.dismiss();
				return 'cancelled';
			}
			const target = context.target;
			if (
				target.type === 'new-chat' &&
				(result.response.contextProjectPath !== target.projectPath ||
					result.response.contextExecutorId !== (target.executorId ?? 'local'))
			) {
				return 'cancelled';
			}
			return await insertExpanded(result.response.expandedText);
		} catch (error) {
			if (key !== this.options.interactionKey) return 'cancelled';
			this.error = error instanceof Error ? error.message : String(error);
			return 'failed';
		} finally {
			if (pendingNotified && !this.expansion.pending) this.options.onPendingChange(false);
		}
	}
}
