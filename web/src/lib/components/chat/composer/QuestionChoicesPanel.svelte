<script lang="ts">
	import { onDestroy } from 'svelte';
	import X from '@lucide/svelte/icons/x';
	import type {
		ResponseChoiceQuestion,
		ResponseChoiceAnswer,
	} from '$lib/chat/composer/response-choices.js';
	import { CommandOutcomeUnknownError } from '$lib/chat/conversation/idempotent-command.js';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		questions: readonly ResponseChoiceQuestion[];
		identity: string;
		disabled?: boolean;
		onSubmit: (answers: ResponseChoiceAnswer[]) => Promise<boolean>;
		onDismiss: () => void;
	}
	let { questions, identity, disabled = false, onSubmit, onDismiss }: Props = $props();
	const componentId = $props.id();
	let draft = $derived({
		identity,
		index: 0,
		selections: {} as Record<string, string[]>,
		error: null as string | null,
		sent: false,
		uncertain: false,
	});
	let pending = $state.raw<{ identity: string; draft: typeof draft } | null>(null);
	let disposed = false;
	const question = $derived(questions[draft.index]);
	const selectedIds = $derived(question ? (draft.selections[question.id] ?? []) : []);
	const isPending = $derived(pending?.identity === identity && pending.draft === draft);
	const unavailable = $derived(disabled || isPending || draft.sent || draft.uncertain);
	onDestroy(() => {
		disposed = true;
	});

	function select(optionId: string): void {
		if (unavailable || !question) return;
		const optionIds = question.allowMultiple
			? selectedIds.includes(optionId)
				? selectedIds.filter((id) => id !== optionId)
				: [...selectedIds, optionId]
			: [optionId];
		draft = {
			...draft,
			selections: { ...draft.selections, [question.id]: optionIds },
			error: null,
		};
		if (!question.allowMultiple) void confirm();
	}

	async function confirm(): Promise<void> {
		if (unavailable || !question || selectedIds.length === 0) return;
		if (draft.index < questions.length - 1) {
			draft = { ...draft, index: draft.index + 1, error: null };
			return;
		}
		const answers = questions.map((prompt) => ({
			questionId: prompt.id,
			selectedOptionIds: prompt.options
				.filter((option) => draft.selections[prompt.id]?.includes(option.id))
				.map((option) => option.id),
		}));
		if (answers.some((answer) => answer.selectedOptionIds.length === 0)) return;
		draft = { ...draft, error: null };
		const attempt = { identity, draft };
		pending = attempt;
		try {
			const accepted = await onSubmit(answers);
			if (disposed || identity !== attempt.identity || draft !== attempt.draft) return;
			draft = { ...draft, sent: accepted, error: accepted ? null : m.chat_async_send_failed() };
		} catch (error) {
			if (disposed || identity !== attempt.identity || draft !== attempt.draft) return;
			const uncertain = error instanceof CommandOutcomeUnknownError;
			draft = {
				...draft,
				uncertain,
				error: uncertain
					? m.chat_async_delivery_unconfirmed()
					: error instanceof Error
						? error.message
						: m.chat_async_send_failed(),
			};
		} finally {
			if (pending === attempt) pending = null;
		}
	}
</script>

{#if question}
	<section
		class="flex max-h-[min(50dvh,28rem)] min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-lg"
		aria-labelledby={`${componentId}-title`}
		data-question-choices-panel
	>
		<div class="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-2">
			<span id={`${componentId}-title`} class="text-xs font-medium text-muted-foreground">
				{m.chat_async_question()} - {question.allowMultiple
					? m.chat_question_select_multiple()
					: m.chat_question_select_one()}
			</span>
			<div class="flex shrink-0 items-center gap-2">
				<span class="text-xs tabular-nums text-muted-foreground"
					>{draft.index + 1}/{questions.length}</span
				>
				<button
					type="button"
					class="inline-flex min-h-9 min-w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
					aria-label={m.chat_async_dismiss_question()}
					disabled={isPending}
					onclick={() => {
						if (!isPending) onDismiss();
					}}
				>
					<X class="size-4" />
				</button>
			</div>
		</div>
		<form
			class="flex min-h-0 flex-col"
			aria-busy={isPending}
			onsubmit={(event) => {
				event.preventDefault();
				void confirm();
			}}
		>
			<div class="min-h-0 overflow-y-auto overscroll-contain px-4 py-3">
				<fieldset class="min-w-0 space-y-2" disabled={unavailable}>
					<legend class="mb-2 text-sm font-medium whitespace-pre-wrap break-words"
						>{question.prompt}</legend
					>
					{#each question.options as option (option.id)}
						<button
							type="button"
							aria-pressed={selectedIds.includes(option.id)}
							onclick={() => select(option.id)}
							class="flex min-h-11 w-full cursor-pointer items-center rounded-lg border border-border bg-background px-3 py-3 text-left text-sm aria-pressed:border-ring aria-pressed:bg-accent aria-pressed:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-60"
						>
							<span class="min-w-0 break-words">
								<span class="block whitespace-pre-wrap font-medium">{option.label}</span>
								{#if option.description}<span
										class="mt-0.5 block text-xs whitespace-pre-wrap text-muted-foreground"
										>{option.description}</span
									>{/if}
							</span>
						</button>
					{/each}
				</fieldset>
				{#if draft.error}<p role="alert" class="mt-3 text-sm whitespace-pre-wrap break-words">
						{draft.error}
					</p>{/if}
				{#if isPending}<p role="status" class="mt-3 text-xs text-muted-foreground">
						{m.chat_async_sending_answer()}
					</p>{/if}
			</div>
			{#if question.allowMultiple}
				<div class="flex shrink-0 justify-end border-t border-border px-4 py-3">
					<button
						type="submit"
						class="min-h-10 rounded-md border border-border bg-accent px-3 py-2 text-sm font-medium text-accent-foreground hover:bg-accent/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
						disabled={unavailable || selectedIds.length === 0}
					>
						{isPending
							? m.chat_async_sending_answer()
							: draft.index < questions.length - 1
								? m.chat_question_next()
								: m.chat_async_send_answer()}
					</button>
				</div>
			{/if}
		</form>
	</section>
{/if}
