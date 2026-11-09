<script lang="ts">
	import type { AsyncQuestionSet } from '$shared/async-user-questions';
	import { hasAsyncQuestionPanel, getAsyncQuestionPanel } from '$lib/chat/conversation/async-question-context.js';
	import MessageCircleQuestionMark from '@lucide/svelte/icons/message-circle-question-mark';
	import * as m from '$lib/paraglide/messages.js';
	import ChatEventCard from './rows/ChatEventCard.svelte';
	import AsyncQuestionPrompt from './AsyncQuestionPrompt.svelte';
	let { questions, ordinal }: { questions: AsyncQuestionSet; ordinal?: number } = $props();
	const panel = hasAsyncQuestionPanel() ? getAsyncQuestionPanel() : undefined;
</script>

<div class="min-w-0" data-async-questions>
	<ChatEventCard variant="info">
		{#snippet header()}
			<div class="flex items-center gap-2">
				<div class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-current/25">
					<MessageCircleQuestionMark class="size-4" />
				</div>
				<span class="text-sm font-semibold">{m.chat_async_question()}</span>
			</div>
		{/snippet}
		{#snippet body()}
			<div class="space-y-3 divide-y divide-border/60">
				{#each questions.questions as question (question.id)}
					<AsyncQuestionPrompt {question} {ordinal} {panel} />
				{/each}
			</div>
		{/snippet}
	</ChatEventCard>
</div>
