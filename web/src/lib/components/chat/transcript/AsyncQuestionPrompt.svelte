<script lang="ts">
	import type { AsyncQuestionPrompt } from '$shared/async-user-questions';
	import { askUserQuestionAnswersValidationError, type AskUserQuestionAnswerPayload } from '$shared/ask-user-question-response';
	import type { AsyncQuestionPanelPort } from '$lib/chat/conversation/async-question-context.js';
	import { asyncQuestionDraftKey } from '$lib/chat/conversation/async-question-controller.svelte.js';
	import type { QuestionDraft } from '$lib/chat/conversation/question-draft.js';
	import * as m from '$lib/paraglide/messages.js';
	import QuestionForm from './QuestionForm.svelte';
	import Reply from '@lucide/svelte/icons/reply';
	import X from '@lucide/svelte/icons/x';

	interface Props {
		question: AsyncQuestionPrompt;
		ordinal?: number;
		panel?: AsyncQuestionPanelPort;
	}

	let { question, ordinal, panel }: Props = $props();
	const formId = $props.id();
	const target = $derived(panel?.identity);
	const key = $derived(target && ordinal ? asyncQuestionDraftKey(target, ordinal, question.id) : '');
	const entry = $derived(panel?.controller.get(key));
	const recorded = $derived(ordinal ? panel?.recordedAnswer(ordinal, question.id) : undefined);
	const replyable = $derived(Boolean(ordinal && panel?.canReply(ordinal)));
	const sending = $derived(entry?.status === 'sending');
	const hasCapacity = $derived(panel?.controller.canRetain(key) ?? true);
	const canAnswer = $derived(Boolean(!sending && hasCapacity && ordinal && panel?.canSubmit(ordinal)));
	const collapsed = $derived(entry?.dismissed || entry?.status === 'sent' || (recorded !== undefined && !entry?.draft));
	const replyLabel = $derived(recorded !== undefined || entry?.status === 'sent' ? m.chat_async_reply_again() : m.chat_async_reply());
	const draft = $derived<QuestionDraft>(entry?.draft ?? {
		selectedQuestionOptions: question.options[0] ? { [question.id]: [question.options[0].id] } : {},
	});

	function edit(next: QuestionDraft): void {
		if (target && panel && !sending) panel.controller.edit(key, target, next);
	}

	function dismiss(): void {
		if (target && panel && !sending) panel.controller.dismiss(key, target, draft);
	}

	function submit(answers: AskUserQuestionAnswerPayload[]): void {
		if (!canAnswer || !target || !panel || !ordinal) return;
		if (askUserQuestionAnswersValidationError([question], answers)) return;
		const selected = answers[0];
		const answer = selected.text ?? question.options.find(option => option.id === selected.selectedOptionIds[0])?.label;
		if (!answer) return;
		void panel.controller.submit(target, ordinal, question, answer, panel.excludedResendOrdinals);
	}
</script>

<section class="min-w-0 space-y-2 border-l-2 border-border pl-3" aria-label={m.chat_async_question()}>
	{#if collapsed || !replyable}
		<p class="whitespace-pre-wrap break-words text-sm font-medium">{question.prompt}</p>
		{#if recorded !== undefined}
			<p class="whitespace-pre-wrap break-words text-sm">{recorded}</p>
		{:else if !entry?.dismissed}
			<ul class="list-inside list-disc text-sm text-muted-foreground">
				{#each question.options as option (option.id)}
					<li class="whitespace-pre-wrap break-words">{option.label}</li>
				{/each}
			</ul>
		{/if}
		{#if replyable}
			<button
				type="button"
				class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
				onclick={() => edit(draft)}
			>
				<Reply class="size-3.5" />{replyLabel}
			</button>
		{/if}
	{:else}
		<QuestionForm
			questions={[question]}
			{formId}
			isPending={!sending && hasCapacity}
			{canAnswer}
			{draft}
			onDraftChange={edit}
			onSubmit={submit}
			submitLabel={m.chat_async_send_answer()}
		/>
		<button
			type="button"
			disabled={sending || !hasCapacity}
			title={m.chat_async_dismiss_question()}
			aria-label={m.chat_async_dismiss_question()}
			class="inline-flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-accent disabled:opacity-50"
			onclick={dismiss}
		>
			<X class="size-4" />
		</button>
	{/if}
	{#if sending}
		<p role="status" class="text-xs text-muted-foreground">{m.chat_async_sending_answer()}</p>
	{:else if replyable && !hasCapacity}
		<p role="status" class="text-xs text-muted-foreground">{m.chat_async_capacity_exhausted()}</p>
	{:else if entry?.message}
		<p role="status" class="whitespace-pre-wrap break-words text-xs text-muted-foreground">{entry.message}</p>
	{/if}
</section>
