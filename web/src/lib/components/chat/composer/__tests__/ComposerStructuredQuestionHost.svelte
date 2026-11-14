<script lang="ts">
	import type { AskUserQuestionPrompt } from '$shared/chat-types';
	import type { AskUserQuestionAnswerPayload } from '$shared/ask-user-question-response';
	import type { QuestionDraft } from '$lib/chat/conversation/question-draft.js';
	import QuestionForm from '../../transcript/QuestionForm.svelte';
	let {
		questions,
		canAnswer = true,
		onSubmit,
	}: {
		questions: readonly AskUserQuestionPrompt[];
		canAnswer?: boolean;
		onSubmit: (answers: AskUserQuestionAnswerPayload[]) => void;
	} = $props();
	let draft = $state<QuestionDraft>({ selectedQuestionOptions: {} });
</script>

<QuestionForm
	{questions}
	formId="composer-permission"
	isPending={true}
	{canAnswer}
	composer={true}
	{draft}
	onDraftChange={(next) => {
		draft = next;
	}}
	{onSubmit}
/>
