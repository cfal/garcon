import { tick } from 'svelte';
import { ApiError } from '$lib/api/client.js';
import type { ComposerState } from '$lib/chat/composer/composer.svelte.js';
import type { SnippetInsertionResult } from '$lib/chat/composer/snippet-insertion.js';
import { applySnippetTriggerReplacement } from '$lib/chat/composer/snippet-trigger.js';
import {
	completeSnippetCommand,
	parseSnippetCommand,
	replaceSnippetCommandName,
	type SnippetCommandParseResult,
} from '$lib/chat/composer/slash-commands.js';
import * as m from '$lib/paraglide/messages.js';
import type { PreamblesStore } from '$lib/preambles/preambles-store.svelte.js';
import {
	matchesSelectableSnippetExpansion,
	type SelectableSnippet,
} from '$lib/snippets/selectable-snippet.js';
import {
	snippetErrorDetail,
	type SnippetExpansionController,
} from '$lib/snippets/snippet-expansion-controller.svelte.js';
import type { SnippetsStore } from '$lib/snippets/snippets-store.svelte.js';
import type { NotificationsStore } from '$lib/stores/notifications.svelte.js';
import type { PromptComposerProjectState } from './prompt-composer-project-state.svelte.js';
import type { PromptComposerUiState } from './prompt-composer-state.svelte.js';

interface PromptComposerSnippetOptions {
	ui: PromptComposerUiState;
	composer: Pick<ComposerState, 'inputText' | 'isDragActive'>;
	expansion: SnippetExpansionController;
	project: Pick<PromptComposerProjectState, 'resolveSnippetContext' | 'matchesSnippetContext'>;
	snippets: Pick<SnippetsStore, 'refreshIfLoaded'>;
	preambles: Pick<PreamblesStore, 'refreshIfLoaded'>;
	notifications: Pick<NotificationsStore, 'error'>;
	get executionKey(): string;
	get conversationInput(): boolean;
	get transformPending(): boolean;
	get textarea(): HTMLTextAreaElement | undefined;
	/** Whether the composer is still mounted and visible to receive caret updates. */
	get active(): boolean;
	setDraft(text: string): void;
	returnFocus(): void;
}

/** Expands snippets into the composer draft from the palette, the `/s` menu, or a submitted `/s` command. */
export class PromptComposerSnippetController {
	constructor(private readonly options: PromptComposerSnippetOptions) {}

	/** Replaces `range`, or the textarea selection, with the expanded snippet. */
	async insert(
		snippet: SelectableSnippet,
		argumentsText: string,
		range: { start: number; end: number } | null = null,
	): Promise<SnippetInsertionResult> {
		const { composer, project, textarea } = this.options;
		if (this.options.transformPending || !textarea) return 'cancelled';
		const sourceExecutionKey = this.options.executionKey;
		this.#closeMenus();
		const sourceText = composer.inputText;
		const start = range?.start ?? textarea.selectionStart;
		const end = range?.end ?? textarea.selectionEnd;
		try {
			const result = await this.options.expansion.runPrepared(snippet.shortName, async (signal) => {
				const operation = await project.resolveSnippetContext(signal);
				return {
					request: {
						shortName: snippet.shortName,
						arguments: { type: 'value', value: argumentsText },
						context: operation.context,
					},
					prepared: operation,
				};
			});
			if (result.kind !== 'expanded') return 'cancelled';
			if (!matchesSelectableSnippetExpansion(snippet, result.response)) {
				if (snippet.source === 'snippet') void this.options.snippets.refreshIfLoaded();
				else void this.options.preambles.refreshIfLoaded();
				this.options.notifications.error(m.snippets_changed_before_expansion());
				await this.settle();
				return 'cancelled';
			}
			if (
				this.options.executionKey !== sourceExecutionKey ||
				!project.matchesSnippetContext(result.prepared, result.response) ||
				composer.inputText !== sourceText
			)
				return 'cancelled';
			const replacement = range
				? applySnippetTriggerReplacement(sourceText, range, result.response.expandedText)
				: {
						text: sourceText.slice(0, start) + result.response.expandedText + sourceText.slice(end),
						caret: start + result.response.expandedText.length,
					};
			this.options.setDraft(replacement.text);
			await this.settle(replacement.caret);
			return 'inserted';
		} catch (error) {
			await this.#reportFailure(error);
			return 'failed';
		}
	}

	/** Replaces the whole draft with the expansion of a submitted `/s` command. */
	async expandCommand(command: Extract<SnippetCommandParseResult, { kind: 'valid' }>): Promise<void> {
		const { composer, project } = this.options;
		if (!this.options.conversationInput) return;
		const sourceExecutionKey = this.options.executionKey;
		const sourceText = composer.inputText;
		this.#closeMenus();
		try {
			const result = await this.options.expansion.runPrepared(command.shortName, async (signal) => {
				const operation = await project.resolveSnippetContext(signal);
				return {
					request: {
						shortName: command.shortName,
						arguments: command.arguments,
						context: operation.context,
					},
					prepared: operation,
				};
			});
			if (result.kind !== 'expanded') return;
			if (
				!this.options.conversationInput ||
				this.options.executionKey !== sourceExecutionKey ||
				!project.matchesSnippetContext(result.prepared, result.response) ||
				composer.inputText !== sourceText
			)
				return;
			this.options.setDraft(result.response.expandedText);
			this.options.ui.closeSlashMenu();
			await this.settle(result.response.expandedText.length);
		} catch (error) {
			await this.#reportFailure(error);
		}
	}

	// Picking from the `/s` menu is the same as submitting `/s <name>` with
	// whatever arguments already follow the name.
	async insertFromCommandMenu(snippet: SelectableSnippet): Promise<void> {
		const trigger = this.options.ui.snippetCommandTrigger;
		this.options.ui.closeSnippetCommandMenu();
		if (this.options.transformPending || !trigger) return;
		const text = replaceSnippetCommandName(this.options.composer.inputText, trigger, snippet.shortName);
		const command = parseSnippetCommand(text);
		if (command.kind !== 'valid') return;
		this.options.setDraft(text);
		this.options.returnFocus();
		await this.expandCommand(command);
	}

	async completeCommandName(snippet: SelectableSnippet): Promise<void> {
		const trigger = this.options.ui.snippetCommandTrigger;
		this.options.ui.closeSnippetCommandMenu();
		if (this.options.transformPending || !trigger) return;
		const completion = completeSnippetCommand(
			this.options.composer.inputText,
			trigger,
			snippet.shortName,
			snippet.source === 'snippet' ? snippet.snippet.defaultArguments : '',
		);
		this.options.setDraft(completion.text);
		await tick();
		const textarea = this.options.textarea;
		textarea?.focus();
		textarea?.setSelectionRange(completion.selectionStart, completion.selectionEnd);
	}

	async settle(caret?: number): Promise<void> {
		await tick();
		if (!this.options.active) return;
		if (caret !== undefined) this.options.textarea?.setSelectionRange(caret, caret);
	}

	#closeMenus(): void {
		this.options.ui.closeSlashMenu();
		this.options.ui.closeSnippetCommandMenu();
		this.options.ui.closeFileMenu();
		this.options.composer.isDragActive = false;
	}

	async #reportFailure(error: unknown): Promise<void> {
		if (error instanceof ApiError && error.status === 404) {
			void this.options.snippets.refreshIfLoaded();
			void this.options.preambles.refreshIfLoaded();
		}
		this.options.notifications.error(m.snippets_expand_error({ detail: snippetErrorDetail(error) }));
		await this.settle();
	}
}
