<script lang="ts">
	import type { AskUserQuestionPrompt } from '$shared/chat-types';
	import {
		askUserQuestionAnswersValidationError,
		normalizeAskUserQuestionDecisionResponse,
		type AskUserQuestionAnsweredResponse,
		type AskUserQuestionAnswerPayload,
	} from '$shared/ask-user-question-response';
	import type { QuestionDraft } from '$lib/chat/conversation/question-draft.js';
	import * as m from '$lib/paraglide/messages.js';
	import Check from '@lucide/svelte/icons/check';
	import X from '@lucide/svelte/icons/x';

	interface Props {
		questions: readonly AskUserQuestionPrompt[];
		formId: string;
		isPending: boolean;
		canAnswer: boolean;
		reason?: string;
		submitLabel?: string;
		submitClass?: string;
		draft: QuestionDraft;
		onDraftChange: (draft: QuestionDraft) => void;
		onSubmit: (answers: AskUserQuestionAnswerPayload[]) => void;
		onSkip?: () => void;
		composer?: boolean;
		questionNumber?: number;
		questionCount?: number;
		onDismiss?: () => void;
	}
	let {
		questions,
		formId,
		isPending,
		canAnswer,
		reason,
		submitLabel = m.chat_permission_submit_answer(),
		submitClass = 'border-border bg-accent text-accent-foreground hover:bg-accent/90',
		draft,
		onDraftChange,
		onSubmit,
		onSkip,
		composer = false,
		questionNumber,
		questionCount,
		onDismiss,
	}: Props = $props();
	let navigation = $derived({ formId, index: 0 });
	const activeQuestion = $derived(questions[navigation.index]);
	const displayedQuestions = $derived(
		composer ? (activeQuestion ? [activeQuestion] : []) : questions,
	);
	const selections = $derived(draft.selectedQuestionOptions);
	const texts = $derived(draft.questionTextAnswers ?? {});
	const notesLabel = $derived(
		isPending ? m.chat_permission_question_notes_optional() : m.chat_permission_question_notes(),
	);
	const response = $derived<AskUserQuestionAnsweredResponse>({
		type: 'ask-user-question-response',
		outcome: 'answered',
		answers: questions.map((question) => ({
			questionId: question.id,
			selectedOptionIds: selectedOptions(question.id),
			...(Object.hasOwn(texts, question.id) ? { text: texts[question.id] } : {}),
		})),
	});
	const valid = $derived(
		Boolean(normalizeAskUserQuestionDecisionResponse(response)) &&
			askUserQuestionAnswersValidationError(questions, response.answers) === null,
	);

	function selectedOptions(id: string): string[] {
		return Object.hasOwn(selections, id) ? selections[id] : [];
	}
	function answerText(id: string): string {
		return Object.hasOwn(texts, id) ? texts[id] : '';
	}
	function textMode(question: AskUserQuestionPrompt): boolean {
		if (!question.allowFreeText || selectedOptions(question.id).length > 0) return false;
		return composer || question.options.length === 0 || Object.hasOwn(texts, question.id);
	}
	function notesMode(question: AskUserQuestionPrompt): boolean {
		return Boolean(question.allowNotes && (composer || selectedOptions(question.id).length > 0));
	}
	function selectedPreviewOptions(question: AskUserQuestionPrompt) {
		const selected = selectedOptions(question.id);
		return question.options.filter((option) => option.preview && selected.includes(option.id));
	}
	function select(question: AskUserQuestionPrompt, optionId: string, checked: boolean): void {
		if (!isPending || (composer && !canAnswer)) return;
		const previousSelection = selectedOptions(question.id);
		const selected = new Set(question.allowMultiple ? previousSelection : []);
		if (checked) selected.add(optionId);
		else selected.delete(optionId);
		const textAnswers = { ...draft.questionTextAnswers };
		const keepNote = question.allowNotes && (composer || previousSelection.length > 0) && selected.size > 0;
		if (!keepNote) delete textAnswers[question.id];
		const next = {
			...draft,
			questionTextAnswers: textAnswers,
			selectedQuestionOptions: { ...draft.selectedQuestionOptions, [question.id]: [...selected] },
		};
		onDraftChange(next);
		if (composer && !question.allowMultiple && checked) confirm(next);
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
	function setNote(questionId: string, text: string): void {
		if (!isPending) return;
		if (text === '') {
			clearText(questionId);
			return;
		}
		onDraftChange({
			...draft,
			questionTextAnswers: { ...draft.questionTextAnswers, [questionId]: text },
		});
	}
	function confirm(next: QuestionDraft = draft): void {
		if (!canAnswer || !isPending) return;
		if (composer && activeQuestion) {
			const selected = next.selectedQuestionOptions[activeQuestion.id] ?? [];
			const text = next.questionTextAnswers?.[activeQuestion.id];
			if (
				askUserQuestionAnswersValidationError(
					[activeQuestion],
					[
						{
							questionId: activeQuestion.id,
							selectedOptionIds: selected,
							...(text !== undefined ? { text } : {}),
						},
					],
				)
			)
				return;
			if (navigation.index < questions.length - 1) {
				navigation = { ...navigation, index: navigation.index + 1 };
				return;
			}
		}
		const answers = questions.map((question) => ({
			questionId: question.id,
			selectedOptionIds: next.selectedQuestionOptions[question.id] ?? [],
			...(Object.hasOwn(next.questionTextAnswers ?? {}, question.id)
				? { text: next.questionTextAnswers?.[question.id] }
				: {}),
		}));
		if (
			!normalizeAskUserQuestionDecisionResponse({
				type: 'ask-user-question-response',
				outcome: 'answered',
				answers,
			}) ||
			askUserQuestionAnswersValidationError(questions, answers)
		)
			return;
		onSubmit(answers);
	}
	const activeValid = $derived(
		Boolean(activeQuestion) &&
			askUserQuestionAnswersValidationError(
				[activeQuestion],
				response.answers.filter((answer) => answer.questionId === activeQuestion.id),
			) === null,
	);

	function skip(): void {
		if (!canAnswer || !isPending) return;
		onSkip?.();
	}
</script>

<form
	class={composer ? 'space-y-3 p-4' : 'space-y-3'}
	onsubmit={(event) => {
		event.preventDefault();
		confirm();
	}}
>
	{#if composer && activeQuestion}
		<div class="flex items-center justify-between gap-3 border-b border-border pb-2">
			<span class="text-xs font-medium text-muted-foreground"
				>{m.chat_async_question()} - {activeQuestion.allowMultiple
					? m.chat_question_select_multiple()
					: m.chat_question_select_one()}</span
			>
			<div class="flex shrink-0 items-center gap-2">
				<span class="text-xs tabular-nums text-muted-foreground"
					>{questionNumber ?? navigation.index + 1}/{questionCount ?? questions.length}</span
				>
				{#if onDismiss}<button
						type="button"
						aria-label={m.chat_async_dismiss_question()}
						onclick={onDismiss}
						class="inline-flex min-h-9 min-w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
						><X class="size-4" /></button
					>{/if}
			</div>
		</div>
	{/if}
	{#each displayedQuestions as question (question.id)}
		<fieldset class="min-w-0 space-y-2">
			<legend class="space-y-1 text-xs font-medium text-foreground break-words">
				{#if question.header}
					<span class="block text-[10px] uppercase text-muted-foreground">{question.header}</span>
				{/if}
				<span class="block whitespace-pre-wrap">{question.prompt}</span>
			</legend>
			<div class="grid gap-1.5">
				{#each question.options as option (option.id)}
					{#if composer}
						<button
							type="button"
							aria-pressed={selectedOptions(question.id).includes(option.id)}
							disabled={!isPending || !canAnswer}
							onclick={() =>
								select(
									question,
									option.id,
									!question.allowMultiple || !selectedOptions(question.id).includes(option.id),
								)}
							class="flex min-h-11 w-full items-center rounded-lg border border-border bg-background px-3 py-3 text-left text-sm aria-pressed:border-ring aria-pressed:bg-accent aria-pressed:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60"
						>
							<span class="min-w-0 break-words"
								><span class="block whitespace-pre-wrap font-medium">{option.label}</span
								>{#if option.description}<span
										class="mt-0.5 block whitespace-pre-wrap text-xs text-muted-foreground"
										>{option.description}</span
									>{/if}</span
							>
						</button>
					{:else}
						<label
							class="flex items-start gap-2 rounded-md border border-border/60 bg-background/50 px-2.5 py-1.5 text-xs text-foreground"
						>
							<input
								type={question.allowMultiple ? 'checkbox' : 'radio'}
								name={`${formId}-${question.id}`}
								checked={selectedOptions(question.id).includes(option.id)}
								disabled={!isPending}
								onchange={(event) => select(question, option.id, event.currentTarget.checked)}
								class="mt-0.5 size-3.5 shrink-0 accent-current"
							/>
							<span class="min-w-0 space-y-0.5 break-words">
								<span class="block whitespace-pre-wrap font-medium">{option.label}</span>
								{#if option.description}
									<span class="block whitespace-pre-wrap text-muted-foreground"
										>{option.description}</span
									>
								{/if}
							</span>
						</label>
					{/if}
				{/each}
				{#if !composer && question.allowFreeText && question.options.length > 0}
					<label class="flex items-center gap-2 text-xs text-foreground">
						<input
							type={question.allowMultiple ? 'checkbox' : 'radio'}
							name={`${formId}-${question.id}`}
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
			{#if (textMode(question) || notesMode(question)) && (isPending || Object.hasOwn(texts, question.id))}
				{#if !isPending && !question.isSecret}
					{#if notesMode(question)}
						<div class="text-xs text-muted-foreground">{notesLabel}</div>
					{/if}
					<p class="whitespace-pre-wrap break-words text-sm text-foreground">
						{answerText(question.id)}
					</p>
				{:else if notesMode(question) && !question.isSecret}
					<label class="block space-y-1 text-xs text-muted-foreground">
						<span>{notesLabel}</span>
						<textarea
							rows="2"
							value={answerText(question.id)}
							oninput={(event) => setNote(question.id, event.currentTarget.value)}
							class="block w-full min-w-0 rounded-md border border-border bg-background px-2.5 py-2 text-base text-foreground"
						></textarea>
					</label>
				{:else}
					{#if notesMode(question)}
						<div class="text-xs text-muted-foreground">{notesLabel}</div>
					{/if}
					<input
						type={question.isSecret ? 'password' : 'text'}
						aria-label={notesMode(question) ? notesLabel : question.prompt}
						value={answerText(question.id)}
						readonly={!isPending}
						oninput={(event) =>
							notesMode(question)
								? setNote(question.id, event.currentTarget.value)
								: setText(question.id, event.currentTarget.value)}
						autocomplete="off"
						class="w-full min-w-0 rounded-md border border-border bg-background px-2.5 py-2 text-base text-foreground"
					/>
				{/if}
			{/if}
			{#each selectedPreviewOptions(question) as option (option.id)}
				<pre
					style:--chat-code-default-size="11px"
					class="typography-chat-code max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/40 p-2 text-[11px] text-foreground">{option.preview}</pre>
			{/each}
		</fieldset>
	{:else}
		<div class="text-xs text-muted-foreground">{m.chat_permission_question_required()}</div>
	{/each}
	{#if reason}
		<p class="whitespace-pre-wrap break-words text-xs text-muted-foreground">{reason}</p>
	{/if}
	{#if isPending}
		<div class="flex flex-wrap gap-2">
			{#if !canAnswer}
				<div class="basis-full text-xs text-muted-foreground" role="status">
					{m.chat_permission_waiting_for_executor()}
				</div>
			{/if}
			{#if !composer || activeQuestion?.allowMultiple || activeQuestion?.options.length === 0 || (activeQuestion?.allowFreeText && selectedOptions(activeQuestion.id).length === 0 && answerText(activeQuestion.id).trim())}
				<button
					type="submit"
					disabled={!canAnswer || (composer ? !activeValid : !valid)}
					class={`inline-flex items-center gap-1.5 rounded-md border text-xs font-medium px-3 py-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${submitClass}`}
				>
					<Check class="w-3.5 h-3.5" />{composer && navigation.index < questions.length - 1
						? m.chat_question_next()
						: submitLabel}
				</button>
			{/if}
			{#if onSkip}
				<button
					type="button"
					onclick={skip}
					disabled={!canAnswer}
					class="inline-flex items-center gap-1.5 rounded-md border border-status-error-border text-status-error-foreground text-xs font-medium px-3 py-1.5 hover:bg-status-error/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
				>
					<X class="w-3.5 h-3.5" />{m.chat_permission_skip()}
				</button>
			{/if}
		</div>
	{/if}
</form>
