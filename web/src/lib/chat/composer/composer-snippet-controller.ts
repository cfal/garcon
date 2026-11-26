import { ApiError } from '$lib/api/client.js';
import type { SnippetCommandParseResult } from '$lib/chat/composer/slash-commands.js';
import type { SnippetInsertionResult } from '$lib/chat/composer/snippet-insertion.js';
import type { SnippetPaletteTriggerState } from '$lib/chat/composer/snippet-palette-trigger-state.svelte.js';
import { applySnippetTriggerReplacement } from '$lib/chat/composer/snippet-trigger.js';
import type { RefreshableCatalog } from '$lib/snippets/catalog-reconnect.js';
import {
	findFreshSelectableSnippetByShortName,
	inspectSelectableSnippetInCatalog,
	tryExpandSelectableSnippetLocally,
	type PreambleCatalogLookup,
	type SnippetCatalogLookup,
} from '$lib/snippets/local-snippet-expansion.js';
import {
	matchesSelectableSnippetExpansion,
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

export interface ComposerSnippetServerContext<Prepared> {
	readonly requestContext: SnippetExpansionContext;
	readonly prepared: Prepared;
}

export interface ComposerSnippetControllerOptions<Prepared> {
	readonly snippets: SnippetCatalogLookup & RefreshableCatalog;
	readonly preambles: PreambleCatalogLookup & RefreshableCatalog;
	readonly notifications: Pick<NotificationsStore, 'error'>;
	readonly isWsConnected: () => boolean;
	readonly getExecutionKey: () => string;
	readonly isConversationInput: () => boolean;
	readonly isTransformPending: () => boolean;
	readonly getText: () => string;
	readonly getSelection: () => { start: number; end: number } | null;
	readonly hasProjectPath: () => boolean;
	readonly getLocalChatId: () => string;
	readonly prepareServerContext: (
		signal: AbortSignal,
	) => ComposerSnippetServerContext<Prepared> | Promise<ComposerSnippetServerContext<Prepared>>;
	readonly matchesServerContext: (
		prepared: Prepared,
		response: Pick<ExpandSnippetResponse, 'contextExecutorId' | 'contextProjectPath'>,
	) => boolean;
	readonly beforeExpand?: () => void;
	readonly onMissingProjectPath?: () => void;
	readonly onExpanded: (text: string, caret: number) => Promise<void> | void;
	readonly onSettled: () => Promise<void> | void;
}

// Coordinates palette and slash-command snippet expansion for immediate composers,
// taking the local fast path when eligible and falling back to server expansion otherwise.
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
		const trigger = palette.trigger;
		const result = await this.#insert(snippet, argumentsText, trigger);
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

	async #insert(
		snippet: SelectableSnippet,
		argumentsText: string,
		range: { start: number; end: number } | null,
	): Promise<SnippetInsertionResult> {
		const selection = this.options.getSelection();
		if (this.options.isTransformPending() || !selection) return 'cancelled';
		const sourceExecutionKey = this.options.getExecutionKey();
		const sourceText = this.options.getText();
		const replacementRange = range ?? { start: selection.start, end: selection.end };
		const argumentsInput: SnippetArgumentsInput = { type: 'value', value: argumentsText };
		this.options.beforeExpand?.();
		try {
			if (!this.options.hasProjectPath() && this.options.onMissingProjectPath) {
				this.options.onMissingProjectPath();
				await this.options.onSettled();
				return 'cancelled';
			}
			const applyExpanded = (expandedText: string) => {
				const replacement = applySnippetTriggerReplacement(
					sourceText,
					replacementRange,
					expandedText,
				);
				return this.options.onExpanded(replacement.text, replacement.caret);
			};
			const catalogState = inspectSelectableSnippetInCatalog(snippet, this.options);
			if (catalogState === 'changed') {
				await this.#notifyAndSettle(m.snippets_changed_before_expansion());
				return 'cancelled';
			}
			if (this.options.hasProjectPath() && catalogState === 'matched') {
				const local = this.#tryExpandLocally(snippet, argumentsInput);
				if (local.kind === 'expanded') {
					await applyExpanded(local.expandedText);
					return 'inserted';
				}
				if (local.kind === 'error') {
					await this.#notifyAndSettle(m.snippets_expand_error({ detail: local.message }));
					return 'failed';
				}
			}
			const result = await this.#expandOnServer(snippet.shortName, argumentsInput);
			if (result.kind !== 'expanded') return 'cancelled';
			const responseChanged = !matchesSelectableSnippetExpansion(snippet, result.response);
			if (responseChanged || inspectSelectableSnippetInCatalog(snippet, this.options) === 'changed') {
				if (responseChanged) {
					const owningCatalog =
						snippet.source === 'snippet' ? this.options.snippets : this.options.preambles;
					void owningCatalog.refreshIfLoaded();
				}
				await this.#notifyAndSettle(m.snippets_changed_before_expansion());
				return 'cancelled';
			}
			if (!this.#isServerResultCurrent(sourceExecutionKey, sourceText, result)) {
				return 'cancelled';
			}
			await applyExpanded(result.response.expandedText);
			return 'inserted';
		} catch (error) {
			await this.#reportServerError(error);
			return 'failed';
		}
	}

	async expandInvocation(
		command: Extract<SnippetCommandParseResult, { kind: 'valid' }>,
	): Promise<void> {
		if (!this.options.isConversationInput() || this.options.isTransformPending()) return;
		const sourceExecutionKey = this.options.getExecutionKey();
		const sourceText = this.options.getText();
		this.options.beforeExpand?.();
		try {
			const hasProjectPath = this.options.hasProjectPath();
			if (!hasProjectPath && this.options.onMissingProjectPath) {
				this.options.onMissingProjectPath();
				return;
			}
			const item = hasProjectPath
				? findFreshSelectableSnippetByShortName(command.shortName, {
						wsConnected: this.options.isWsConnected(),
						snippets: this.options.snippets,
						preambles: this.options.preambles,
					})
				: null;
			if (item) {
				const local = this.#tryExpandLocally(item, command.arguments);
				if (local.kind === 'expanded') {
					await this.options.onExpanded(local.expandedText, local.expandedText.length);
					return;
				}
				if (local.kind === 'error') {
					await this.#notifyAndSettle(m.snippets_expand_error({ detail: local.message }));
					return;
				}
			}
			const result = await this.#expandOnServer(command.shortName, command.arguments);
			if (
				result.kind !== 'expanded' ||
				!this.options.isConversationInput() ||
				!this.#isServerResultCurrent(sourceExecutionKey, sourceText, result)
			) {
				return;
			}
			await this.options.onExpanded(
				result.response.expandedText,
				result.response.expandedText.length,
			);
		} catch (error) {
			await this.#reportServerError(error);
		}
	}

	#tryExpandLocally(item: SelectableSnippet, argumentsInput: SnippetArgumentsInput) {
		return tryExpandSelectableSnippetLocally(item, argumentsInput, {
			kind: 'immediate',
			getChatId: () => this.options.getLocalChatId(),
		});
	}

	#isServerResultCurrent(
		sourceExecutionKey: string,
		sourceText: string,
		result: {
			readonly prepared: Prepared;
			readonly response: Pick<ExpandSnippetResponse, 'contextExecutorId' | 'contextProjectPath'>;
		},
	): boolean {
		return (
			this.options.getExecutionKey() === sourceExecutionKey &&
			this.options.matchesServerContext(result.prepared, result.response) &&
			this.options.getText() === sourceText
		);
	}

	#expandOnServer(shortName: string, argumentsInput: SnippetArgumentsInput) {
		return this.#expansion.runPrepared(shortName, async (signal) => {
			const operation = await this.options.prepareServerContext(signal);
			return {
				request: {
					shortName,
					arguments: argumentsInput,
					context: operation.requestContext,
				},
				prepared: operation.prepared,
			};
		});
	}

	async #notifyAndSettle(message: string): Promise<void> {
		this.options.notifications.error(message);
		await this.options.onSettled();
	}

	async #reportServerError(error: unknown): Promise<void> {
		if (error instanceof ApiError && error.status === 404) {
			void this.options.snippets.refreshIfLoaded();
			void this.options.preambles.refreshIfLoaded();
		}
		await this.#notifyAndSettle(m.snippets_expand_error({ detail: snippetErrorDetail(error) }));
	}
}
