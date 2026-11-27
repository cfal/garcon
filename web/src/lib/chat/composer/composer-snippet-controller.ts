import { ApiError } from '$lib/api/client.js';
import type { SnippetCommandParseResult } from '$lib/chat/composer/slash-commands.js';
import type { SnippetInsertionResult } from '$lib/chat/composer/snippet-insertion.js';
import type { SnippetPaletteTriggerState } from '$lib/chat/composer/snippet-palette-trigger-state.svelte.js';
import { applySnippetTriggerReplacement } from '$lib/chat/composer/snippet-trigger.js';
import {
	findLoadedSelectableSnippetByShortName,
	tryExpandSelectableSnippetLocally,
	type PreambleCatalogLookup,
	type SnippetCatalogLookup,
} from '$lib/snippets/local-snippet-expansion.js';
import {
	mismatchedSnippetSources,
	type SelectableSnippet,
} from '$lib/snippets/selectable-snippet.js';
import {
	SnippetExpansionController,
	snippetErrorDetail,
} from '$lib/snippets/snippet-expansion-controller.svelte.js';
import type { NotificationsStore } from '$lib/stores/notifications.svelte.js';
import * as m from '$lib/paraglide/messages.js';
import {
	snippetTemplateUsesArguments,
	type ExpandSnippetResponse,
	type SnippetArgumentsInput,
	type SnippetExpansionContext,
} from '$shared/snippets';

interface RefreshableCatalog {
	refreshIfLoaded(): Promise<void>;
}

export interface ComposerSnippetServerContext<Prepared> {
	readonly requestContext: SnippetExpansionContext;
	readonly prepared: Prepared;
}

export interface ComposerSnippetControllerOptions<Prepared> {
	readonly snippets: SnippetCatalogLookup & RefreshableCatalog;
	readonly preambles: PreambleCatalogLookup & RefreshableCatalog;
	readonly notifications: Pick<NotificationsStore, 'error'>;
	readonly getExecutionKey: () => string;
	readonly isConversationInput: () => boolean;
	readonly isTransformPending: () => boolean;
	readonly getText: () => string;
	readonly getSelection: () => { start: number; end: number } | null;
	readonly hasProjectPath: () => boolean;
	readonly getLocalChatId: () => string;
	readonly buildServerContext: () => ComposerSnippetServerContext<Prepared>;
	readonly matchesServerContext: (
		prepared: Prepared,
		response: Pick<ExpandSnippetResponse, 'contextExecutorId' | 'contextProjectPath'>,
	) => boolean;
	readonly beforeExpand?: () => void;
	readonly onMissingProjectPath?: () => void;
	readonly onExpanded: (text: string, caret: number) => Promise<void> | void;
	readonly onSettled: () => Promise<void> | void;
}

type SnippetInvocation =
	| {
			readonly kind: 'palette';
			readonly snippet: SelectableSnippet;
			readonly argumentsInput: SnippetArgumentsInput;
			readonly range: { start: number; end: number };
	  }
	| {
			readonly kind: 'slash';
			readonly shortName: string;
			readonly argumentsInput: SnippetArgumentsInput;
	  };

// Coordinates palette and slash-command snippet expansion for immediate composers,
// applying a best-effort local fast path when eligible and falling back to server expansion otherwise.
export class ComposerSnippetController<Prepared> {
	readonly #expansion = new SnippetExpansionController();

	constructor(private readonly options: ComposerSnippetControllerOptions<Prepared>) {}

	get pending(): boolean {
		return this.#expansion.pending;
	}

	cancel(): void {
		this.#expansion.cancel();
	}

	async insertFromPalette(
		palette: Pick<SnippetPaletteTriggerState, 'trigger' | 'complete' | 'dismiss'>,
		snippet: SelectableSnippet,
		argumentsText: string,
	): Promise<SnippetInsertionResult> {
		const selection = this.options.getSelection();
		if (this.options.isTransformPending() || !selection) {
			palette.dismiss();
			return 'cancelled';
		}
		const range = palette.trigger ?? { start: selection.start, end: selection.end };
		const result = await this.#execute({
			kind: 'palette',
			snippet,
			argumentsInput: { type: 'value', value: argumentsText },
			range,
		});
		if (result === 'inserted') palette.complete();
		else if (
			result !== 'failed' ||
			snippet.source !== 'snippet' ||
			!snippetTemplateUsesArguments(snippet.body)
		) {
			palette.dismiss();
		}
		return result;
	}

	async expandInvocation(
		command: Extract<SnippetCommandParseResult, { kind: 'valid' }>,
	): Promise<void> {
		if (!this.options.isConversationInput() || this.options.isTransformPending()) return;
		await this.#execute({
			kind: 'slash',
			shortName: command.shortName,
			argumentsInput: command.arguments,
		});
	}

	async #execute(invocation: SnippetInvocation): Promise<SnippetInsertionResult> {
		const sourceExecutionKey = this.options.getExecutionKey();
		const sourceText = this.options.getText();
		this.options.beforeExpand?.();
		const applyExpanded = (expandedText: string) => {
			if (invocation.kind === 'palette') {
				const replacement = applySnippetTriggerReplacement(
					sourceText,
					invocation.range,
					expandedText,
				);
				return this.options.onExpanded(replacement.text, replacement.caret);
			}
			return this.options.onExpanded(expandedText, expandedText.length);
		};
		try {
			if (!this.options.hasProjectPath() && this.options.onMissingProjectPath) {
				this.options.onMissingProjectPath();
				if (invocation.kind === 'palette') await this.options.onSettled();
				return 'cancelled';
			}
			if (this.options.hasProjectPath()) {
				const localItem =
					invocation.kind === 'palette'
						? invocation.snippet
						: findLoadedSelectableSnippetByShortName(invocation.shortName, this.options);
				if (localItem) {
					const local = tryExpandSelectableSnippetLocally(
						localItem,
						invocation.argumentsInput,
						{ kind: 'immediate', getChatId: () => this.options.getLocalChatId() },
					);
					if (local.kind === 'expanded') {
						await applyExpanded(local.expandedText);
						return 'inserted';
					}
					if (local.kind === 'error') {
						await this.#notifyAndSettle(
							m.snippets_expand_error({ detail: local.message }),
						);
						return 'failed';
					}
				}
			}
			const { requestContext, prepared } = this.options.buildServerContext();
			const shortName =
				invocation.kind === 'palette' ? invocation.snippet.shortName : invocation.shortName;
			const result = await this.#expansion.run({
				shortName,
				arguments: invocation.argumentsInput,
				context: requestContext,
			});
			if (result.kind !== 'expanded') return 'cancelled';
			if (invocation.kind === 'palette') {
				const staleSources = mismatchedSnippetSources(invocation.snippet, result.response);
				if (staleSources.length > 0) {
					this.#refreshSources(staleSources);
					await this.#notifyAndSettle(m.snippets_changed_before_expansion());
					return 'cancelled';
				}
			}
			if (
				(invocation.kind === 'slash' && !this.options.isConversationInput()) ||
				this.options.getExecutionKey() !== sourceExecutionKey ||
				!this.options.matchesServerContext(prepared, result.response) ||
				this.options.getText() !== sourceText
			) {
				return 'cancelled';
			}
			await applyExpanded(result.response.expandedText);
			return 'inserted';
		} catch (error) {
			if (error instanceof ApiError && error.status === 404) {
				this.#refreshSources(['snippet', 'preamble']);
			}
			await this.#notifyAndSettle(
				m.snippets_expand_error({ detail: snippetErrorDetail(error) }),
			);
			return 'failed';
		}
	}

	#refreshSources(sources: readonly SelectableSnippet['source'][]): void {
		for (const source of sources) {
			const catalog = source === 'snippet' ? this.options.snippets : this.options.preambles;
			void catalog.refreshIfLoaded();
		}
	}

	async #notifyAndSettle(message: string): Promise<void> {
		this.options.notifications.error(message);
		await this.options.onSettled();
	}
}
