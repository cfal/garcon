<script lang="ts">
	import type { AsyncQuestionSet } from '$shared/async-user-questions';
	import { hasAsyncQuestionPanel, getAsyncQuestionPanel } from '$lib/chat/conversation/async-question-context.js';
	import AsyncQuestionPrompt from './AsyncQuestionPrompt.svelte';
	let { questions, ordinal }: { questions: AsyncQuestionSet; ordinal?: number } = $props();
	const panel = hasAsyncQuestionPanel() ? getAsyncQuestionPanel() : undefined;
</script>

<div class="min-w-0 space-y-5" data-async-questions>
	{#each questions.questions as question (question.id)}
		<AsyncQuestionPrompt {question} {ordinal} {panel} />
	{/each}
</div>
