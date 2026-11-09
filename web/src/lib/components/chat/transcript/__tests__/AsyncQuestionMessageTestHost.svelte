<script lang="ts">
	import { untrack } from 'svelte';
	import type { AsyncQuestionSet } from '$shared/async-user-questions';
	import { setAsyncQuestionPanel, type AsyncQuestionPanelPort } from '$lib/chat/conversation/async-question-context.js';
	import AsyncQuestionMessage from '../AsyncQuestionMessage.svelte';

	let { questions, panel }: { questions: AsyncQuestionSet; panel: AsyncQuestionPanelPort } = $props();
	setAsyncQuestionPanel(untrack(() => panel));
</script>

<AsyncQuestionMessage {questions} ordinal={3} />
