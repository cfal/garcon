<script lang="ts">
	import type { AskUserQuestionPrompt, AskUserQuestionToolUseMessage } from '$shared/chat-types';
	import {
		askUserQuestionDecisionValidationError,
		normalizeAskUserQuestionDecisionResponse,
		type AskUserQuestionDecisionResponse,
	} from '$shared/ask-user-question-response';
	import type { PermissionDecisionPayload } from '$shared/chat-command-contracts';
	import type { PermissionTerminalState } from '$lib/chat/transcript/conversation-feed-items.js';
	import type { PermissionQuestionDraft } from './ConversationFeedItemState.svelte.js';
	import * as m from '$lib/paraglide/messages.js';
	import Check from '@lucide/svelte/icons/check';
	import X from '@lucide/svelte/icons/x';

	interface Props {
		tool: AskUserQuestionToolUseMessage;
		permissionOccurrenceId: string;
		isPending: boolean;
		canAnswer: boolean;
		terminal?: PermissionTerminalState;
		draft: PermissionQuestionDraft;
		onDraftChange: (draft: PermissionQuestionDraft) => void;
		onDecision: (decision: PermissionDecisionPayload) => void;
	}
	let {
		tool,
		permissionOccurrenceId,
		isPending,
		canAnswer,
		terminal,
		draft,
		onDraftChange,
		onDecision,
	}: Props = $props();
	const selections = $derived(
		terminal ? (terminal.selectedQuestionOptions ?? {}) : draft.selectedQuestionOptions,
	);
	const texts = $derived(
		terminal ? (terminal.questionTextAnswers ?? {}) : (draft.questionTextAnswers ?? {}),
	);
	const response = $derived<AskUserQuestionDecisionResponse>({
		type: 'ask-user-question-response',
		outcome: 'answered',
		answers: tool.questions.map((question) => ({
			questionId: question.id,
			selectedOptionIds: selectedOptions(question.id),
			...(Object.hasOwn(texts, question.id) ? { text: texts[question.id] } : {}),
		})),
	});
	const valid = $derived(
		Boolean(normalizeAskUserQuestionDecisionResponse(response)) &&
			askUserQuestionDecisionValidationError(tool, true, response) === null,
	);

	function selectedOptions(id: string): string[] {
		return Object.hasOwn(selections, id) ? selections[id] : [];
	}
	function textMode(question: AskUserQuestionPrompt): boolean {
		return Boolean(
			question.allowFreeText &&
			(question.options.length === 0 || Object.hasOwn(texts, question.id)),
		);
	}
	function select(question: AskUserQuestionPrompt, optionId: string, checked: boolean): void {
		if (!isPending) return;
		const selected = new Set(question.allowMultiple ? selectedOptions(question.id) : []);
		if (checked) selected.add(optionId);
		else selected.delete(optionId);
		const textAnswers = { ...draft.questionTextAnswers };
		delete textAnswers[question.id];
		onDraftChange({
			...draft,
			questionTextAnswers: textAnswers,
			selectedQuestionOptions: { ...draft.selectedQuestionOptions, [question.id]: [...selected] },
		});
	}
	function setText(questionId: string, text: string): void {
		if (!isPending) return;
		onDraftChange({
			...draft,
			selectedQuestionOptions: { ...draft.selectedQuestionOptions, [questionId]: [] },
			questionTextAnswers: { ...draft.questionTextAnswers, [questionId]: text },
		});
	}
	function clearText(questionId: string): void {
		if (!isPending) return;
		const textAnswers = { ...draft.questionTextAnswers };
		delete textAnswers[questionId];
		onDraftChange({ ...draft, questionTextAnswers: textAnswers });
	}
	function submit(): void {
		if (!canAnswer || !isPending || !valid) return;
		onDecision({ allow: true, response });
	}
	function skip(): void {
		if (!canAnswer || !isPending) return;
		onDecision({
			allow: false,
			response: {
				type: 'ask-user-question-response',
				outcome: 'skipped',
				reason: 'User skipped question',
			},
		});
	}
</script>

<form
	class="space-y-3"
	onsubmit={(event) => {
		event.preventDefault();
		submit();
	}}
>
	{#each tool.questions as question (question.id)}
		<fieldset class="min-w-0 space-y-2">
			<legend class="text-xs font-medium text-foreground break-words">
				{#if question.header}<span class="block text-[10px] uppercase text-muted-foreground"
						>{question.header}</span
					>{/if}
				<span class="block whitespace-pre-wrap">{question.prompt}</span>
			</legend>
			<div class="grid gap-1.5">
				{#each question.options as option (option.id)}
					<label
						class="flex items-start gap-2 rounded-md border border-border/60 bg-background/50 px-2.5 py-1.5 text-xs text-foreground"
					>
						<input
							type={question.allowMultiple ? 'checkbox' : 'radio'}
							name={`${permissionOccurrenceId}-${question.id}`}
							checked={selectedOptions(question.id).includes(option.id)}
							disabled={!isPending}
							onchange={(event) => select(question, option.id, event.currentTarget.checked)}
							class="mt-0.5 size-3.5 shrink-0 accent-current"
						/>
						<span class="min-w-0 break-words"
							><span class="block whitespace-pre-wrap font-medium">{option.label}</span>
							{#if option.description}<span class="block whitespace-pre-wrap text-muted-foreground"
									>{option.description}</span
								>{/if}
						</span>
					</label>
				{/each}
				{#if question.allowFreeText && question.options.length > 0}
					<label class="flex items-center gap-2 text-xs text-foreground">
						<input
							type={question.allowMultiple ? 'checkbox' : 'radio'}
							name={`${permissionOccurrenceId}-${question.id}`}
							checked={textMode(question)}
							disabled={!isPending}
							onchange={(event) =>
								event.currentTarget.checked ? setText(question.id, '') : clearText(question.id)}
							class="size-3.5 accent-current"
						/>
						{m.chat_permission_question_other()}
					</label>
				{/if}
			</div>
			{#if textMode(question)}
				{#if !isPending && !question.isSecret}
					<p class="whitespace-pre-wrap break-words text-sm text-foreground">
						{texts[question.id]}
					</p>
				{:else}
					<input
						type={question.isSecret ? 'password' : 'text'}
						aria-label={question.prompt}
						value={Object.hasOwn(texts, question.id) ? texts[question.id] : ''}
						readonly={!isPending}
						oninput={(event) => setText(question.id, event.currentTarget.value)}
						autocomplete="off"
						class="w-full min-w-0 rounded-md border border-border bg-background px-2.5 py-2 text-base text-foreground"
					/>
				{/if}
			{/if}
			{#each question.options.filter((option) => option.preview && selectedOptions(question.id).includes(option.id)) as option (option.id)}
				<pre
					class="typography-chat-code max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/40 p-2 text-xs text-foreground">{option.preview}</pre>
			{/each}
		</fieldset>
	{/each}
	{#if terminal?.reason}
		<p class="whitespace-pre-wrap break-words text-xs text-muted-foreground">{terminal.reason}</p>
	{/if}
	{#if isPending}
		<div class="flex flex-wrap gap-2">
			{#if !canAnswer}<div class="basis-full text-xs text-muted-foreground" role="status">
					{m.chat_permission_waiting_for_executor()}
				</div>{/if}
			<button
				type="submit"
				disabled={!canAnswer || !valid}
				class="inline-flex items-center gap-1.5 rounded-md border border-status-warning-border bg-status-warning text-status-warning-foreground text-xs font-medium px-3 py-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
			>
				<Check class="w-3.5 h-3.5" />{m.chat_permission_submit_answer()}
			</button>
			<button
				type="button"
				onclick={skip}
				disabled={!canAnswer}
				class="inline-flex items-center gap-1.5 rounded-md border border-status-error-border text-status-error-foreground text-xs font-medium px-3 py-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
			>
				<X class="w-3.5 h-3.5" />{m.chat_permission_skip()}
			</button>
		</div>
	{/if}
</form>
