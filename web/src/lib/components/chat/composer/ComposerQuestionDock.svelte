<script lang="ts">
	import type { PermissionDecisionPayload } from '$shared/chat-command-contracts';
	import type { ComposerQuestion } from '$lib/chat/composer/composer-question.js';
	import type { ResponseChoiceAnswer } from '$lib/chat/composer/response-choices.js';
	import { asyncQuestionDraftKey } from '$lib/chat/conversation/async-question-controller.svelte.js';
	import type { AsyncQuestionPanelPort } from '$lib/chat/conversation/async-question-context.js';
	import type { ResponseChoiceStatus } from '$lib/chat/conversation/response-choice-controller.svelte.js';
	import type { PermissionQuestionDraft } from '../transcript/ConversationFeedItemState.svelte.js';
	import AskUserQuestionForm from '../transcript/AskUserQuestionForm.svelte';
	import AsyncQuestionPrompt from '../transcript/AsyncQuestionPrompt.svelte';
	import QuestionChoicesPanel from './QuestionChoicesPanel.svelte';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		question: ComposerQuestion;
		identity: string;
		asyncPanel: AsyncQuestionPanelPort;
		canAnswer: boolean;
		deliveryStatus?: ResponseChoiceStatus;
		onDecision: (permissionOccurrenceId: string, decision: PermissionDecisionPayload) => void;
		onSubmit: (answers: readonly ResponseChoiceAnswer[]) => Promise<boolean>;
		onDismiss: () => void;
	}
	let {
		question,
		identity,
		asyncPanel,
		canAnswer,
		deliveryStatus,
		onDecision,
		onSubmit,
		onDismiss,
	}: Props = $props();
	let draftIdentity = $state('');
	let permissionDraft = $state<PermissionQuestionDraft>({
		selectedQuestionOptions: {},
		rawInputOpen: false,
	});
	const draft = $derived(
		draftIdentity === identity
			? permissionDraft
			: { selectedQuestionOptions: {}, rawInputOpen: false },
	);
	const asyncQuestions = $derived(
		question.kind === 'async' ? (question.message.questions?.questions ?? []) : [],
	);
	const asyncIndex = $derived(
		asyncQuestions.findIndex((prompt) => {
			if (question.kind !== 'async') return false;
			const entry = asyncPanel.controller.get(
				asyncQuestionDraftKey(asyncPanel.identity, question.ordinal, prompt.id),
			);
			return (
				!entry?.dismissed &&
				entry?.status !== 'sent' &&
				(asyncPanel.recordedAnswer(question.ordinal, prompt.id) === undefined ||
					Boolean(entry?.draft))
			);
		}),
	);
	const asyncPrompt = $derived(asyncQuestions[asyncIndex]);
</script>

<div
	class="min-h-0 max-h-[min(50dvh,28rem)] overflow-y-auto overscroll-contain pb-2"
	data-composer-question-dock
>
	{#if question.kind === 'plain'}
		<QuestionChoicesPanel
			questions={question.questions}
			{identity}
			disabled={!canAnswer || deliveryStatus !== undefined}
			{onSubmit}
			{onDismiss}
		/>
		{#if deliveryStatus === 'sending' || deliveryStatus === 'unknown'}
			<p role="status" class="px-3 py-1 text-xs text-muted-foreground">
				{deliveryStatus === 'sending'
					? m.chat_async_sending_answer()
					: m.chat_async_delivery_unconfirmed()}
			</p>
		{/if}
	{:else}
		<section
			class="relative min-w-0 rounded-xl border border-border bg-card text-card-foreground shadow-lg"
			aria-label={m.chat_async_question()}
		>
			{#if question.kind === 'permission'}
				<AskUserQuestionForm
					tool={question.request.requestedTool}
					permissionOccurrenceId={`composer-${question.request.permissionOccurrenceId}`}
					isPending={true}
					{canAnswer}
					composer={true}
					{onDismiss}
					{draft}
					onDraftChange={(next) => {
						draftIdentity = identity;
						permissionDraft = next;
					}}
					onDecision={(decision) => {
						if (question.kind === 'permission' && canAnswer)
							onDecision(question.request.permissionOccurrenceId, decision);
					}}
				/>
			{:else}
				{#if asyncPrompt}
					<AsyncQuestionPrompt
						question={asyncPrompt}
						ordinal={question.ordinal}
						panel={asyncPanel}
						composer={true}
						questionNumber={asyncIndex + 1}
						questionCount={asyncQuestions.length}
						{onDismiss}
					/>
				{/if}
			{/if}
		</section>
	{/if}
</div>
