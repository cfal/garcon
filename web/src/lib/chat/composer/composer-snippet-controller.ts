import { ApiError } from '$lib/api/client.js';
import type { SnippetCommandParseResult } from '$lib/chat/composer/slash-commands.js';
import type { SnippetInsertionResult } from '$lib/chat/composer/snippet-insertion.js';
import { applySnippetTriggerReplacement } from '$lib/chat/composer/snippet-trigger.js';
import type { PreamblesStore } from '$lib/preambles/preambles-store.svelte.js';
import {
	catalogMatchesSelectableSnippet,
	findFreshSelectableSnippetByShortName,
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
import type { ExpandSnippetResponse, SnippetExpansionContext } from '$shared/snippets';

export interface ComposerSnippetServerContext<Prepared> {
	readonly requestContext: SnippetExpansionContext;
	readonly prepared: Prepared;
}

export interface ComposerSnippetControllerOptions<Prepared> {
	readonly snippets: SnippetCatalogLookup & Pick<SnippetsStoreLike, 'refreshIfLoaded'>;
	readonly preambles: PreambleCatalogLookup & Pick<PreamblesStore, 'refreshIfLoaded'>;
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

interface SnippetsStoreLike {
	refreshIfLoaded(): Promise<void>;
}

function replaceSnippetText(
	sourceText: string,
	start: number,
	end: number,
	range: { start: number; end: number } | null,
	expandedText: string,
) {
	return range
		? applySnippetTriggerReplacement(sourceText, range, expandedText)
		: {
				text: sourceText.slice(0, start) + expandedText + sourceText.slice(end),
				caret: start + expandedText.length,
			};
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

	async insert(
		snippet: SelectableSnippet,
		argumentsText: string,
		range: { start: number; end: number } | null = null,
	): Promise<SnippetInsertionResult> {
		const selection = this.options.getSelection();
		if (this.options.isTransformPending() || !selection) return 'cancelled';
		const sourceExecutionKey = this.options.getExecutionKey();
		this.options.beforeExpand?.();
		const owningCatalog =
			snippet.source === 'snippet' ? this.options.snippets : this.options.preambles;
		try {
			const hasProjectPath = this.options.hasProjectPath();
			if (!hasProjectPath && this.options.onMissingProjectPath) {
				this.options.onMissingProjectPath();
				await this.options.onSettled();
				return 'cancelled';
			}
			const sourceText = this.options.getText();
			const start = range?.start ?? selection.start;
			const end = range?.end ?? selection.end;
			if (hasProjectPath && catalogMatchesSelectableSnippet(snippet, owningCatalog)) {
				const local = tryExpandSelectableSnippetLocally(
					snippet,
					{ type: 'value', value: argumentsText },
					{ kind: 'immediate', getChatId: () => this.options.getLocalChatId() },
				);
				if (local.kind === 'expanded') {
					const replacement = replaceSnippetText(sourceText, start, end, range, local.expandedText);
					await this.options.onExpanded(replacement.text, replacement.caret);
					return 'inserted';
				}
				if (local.kind === 'error') {
					this.options.notifications.error(m.snippets_expand_error({ detail: local.message }));
					await this.options.onSettled();
					return 'failed';
				}
			}
			const result = await this.#expansion.runPrepared(snippet.shortName, async (signal) => {
				const operation = await this.options.prepareServerContext(signal);
				return {
					request: {
						shortName: snippet.shortName,
						arguments: { type: 'value', value: argumentsText },
						context: operation.requestContext,
					},
					prepared: operation.prepared,
				};
			});
			if (result.kind !== 'expanded') return 'cancelled';
			if (!matchesSelectableSnippetExpansion(snippet, result.response)) {
				if (snippet.source === 'snippet') void this.options.snippets.refreshIfLoaded();
				else void this.options.preambles.refreshIfLoaded();
				this.options.notifications.error(m.snippets_changed_before_expansion());
				await this.options.onSettled();
				return 'cancelled';
			}
			if (
				this.options.getExecutionKey() !== sourceExecutionKey ||
				!this.options.matchesServerContext(result.prepared, result.response) ||
				this.options.getText() !== sourceText
			) {
				return 'cancelled';
			}
			const replacement = replaceSnippetText(
				sourceText,
				start,
				end,
				range,
				result.response.expandedText,
			);
			await this.options.onExpanded(replacement.text, replacement.caret);
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
			if (hasProjectPath) {
				const item = findFreshSelectableSnippetByShortName(command.shortName, {
					wsConnected: this.options.isWsConnected(),
					snippets: this.options.snippets,
					preambles: this.options.preambles,
				});
				if (item) {
					const local = tryExpandSelectableSnippetLocally(item, command.arguments, {
						kind: 'immediate',
						getChatId: () => this.options.getLocalChatId(),
					});
					if (local.kind === 'expanded') {
						await this.options.onExpanded(local.expandedText, local.expandedText.length);
						return;
					}
					if (local.kind === 'error') {
						this.options.notifications.error(m.snippets_expand_error({ detail: local.message }));
						await this.options.onSettled();
						return;
					}
				}
			}
			const result = await this.#expansion.runPrepared(command.shortName, async (signal) => {
				const operation = await this.options.prepareServerContext(signal);
				return {
					request: {
						shortName: command.shortName,
						arguments: command.arguments,
						context: operation.requestContext,
					},
					prepared: operation.prepared,
				};
			});
			if (result.kind !== 'expanded') return;
			if (
				!this.options.isConversationInput() ||
				this.options.getExecutionKey() !== sourceExecutionKey ||
				!this.options.matchesServerContext(result.prepared, result.response) ||
				this.options.getText() !== sourceText
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

	async #reportServerError(error: unknown): Promise<void> {
		if (error instanceof ApiError && error.status === 404) {
			void this.options.snippets.refreshIfLoaded();
			void this.options.preambles.refreshIfLoaded();
		}
		this.options.notifications.error(m.snippets_expand_error({ detail: snippetErrorDetail(error) }));
		await this.options.onSettled();
	}
}
