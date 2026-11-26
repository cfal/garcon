import type { ScheduledSnippetExpansionContext } from '$shared/snippets';
import type { SelectableSnippet } from '$lib/snippets/selectable-snippet.js';
import { matchesSelectableSnippetExpansion } from '$lib/snippets/selectable-snippet.js';
import { SnippetExpansionController } from '$lib/snippets/snippet-expansion-controller.svelte.js';
import {
	tryExpandSelectableSnippetLocally,
	type CatalogSelectableSnippetState,
} from '$lib/snippets/local-snippet-expansion.js';
import { SnippetPaletteTriggerState } from '$lib/chat/composer/snippet-palette-trigger-state.svelte.js';
import {
	applySnippetTriggerReplacement,
	findSnippetTrigger,
} from '$lib/chat/composer/snippet-trigger.js';
import type { SnippetInsertionResult } from '$lib/chat/composer/snippet-insertion.js';
import * as m from '$lib/paraglide/messages.js';

interface Options {
	get prompt(): string;
	get context(): ScheduledSnippetExpansionContext | null;
	get interactionKey(): string;
	inspectCatalogItem(item: SelectableSnippet): CatalogSelectableSnippetState;
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
			const catalogState = this.options.inspectCatalogItem(snippet);
			if (catalogState === 'changed') {
				this.error = m.snippets_changed_before_expansion();
				return 'cancelled';
			}
			if (catalogState === 'matched') {
				const local = tryExpandSelectableSnippetLocally(snippet, argumentsInput, {
					kind: 'scheduled',
				});
				if (local.kind === 'expanded') return await insertExpanded(local.expandedText);
				if (local.kind === 'error') {
					this.error = local.message;
					return 'failed';
				}
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
			)
				return 'cancelled';
			const responseChanged = !matchesSelectableSnippetExpansion(snippet, result.response);
			if (
				responseChanged ||
				this.options.inspectCatalogItem(snippet) === 'changed'
			) {
				this.error = m.snippets_changed_before_expansion();
				if (responseChanged) {
					this.options.onSourceChanged(snippet.source);
					if (result.response.source !== snippet.source) {
						this.options.onSourceChanged(result.response.source);
					}
				}
				return 'cancelled';
			}
			const target = context.target;
			if (
				target.type === 'new-chat' &&
				(result.response.contextProjectPath !== target.projectPath ||
					result.response.contextExecutorId !== (target.executorId ?? 'local'))
			)
				return 'cancelled';
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
