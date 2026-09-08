<script lang="ts">
	import { onDestroy } from 'svelte';
	import { setMinuteClock } from '$lib/context';
	import type { ChatBoardOccurrence } from '$lib/chat-board/projection/chat-board-projection.js';
	import { MinuteClockStore } from '$lib/stores/minute-clock.svelte.js';
	import type { ChatTagReconciliationKind } from '$lib/chat/sessions/chat-sessions-contract.js';
	import ChatBoardCard from '../ChatBoardCard.svelte';

	let {
		occurrence,
		currentTime,
		reconciliationKind = null,
	}: {
		occurrence: ChatBoardOccurrence;
		currentTime: Date;
		reconciliationKind?: ChatTagReconciliationKind;
	} = $props();

	const minuteClock = new MinuteClockStore();
	setMinuteClock(minuteClock);
	$effect(() => {
		minuteClock.currentTime = currentTime;
	});
	onDestroy(() => minuteClock.destroy());
</script>

<ChatBoardCard
	{occurrence}
	layout="detailed"
	instanceId="instance"
	boardId="board"
	canDrag={false}
	pending={false}
	{reconciliationKind}
	canTransition
	occurrenceIndex={0}
	onOpen={() => {}}
	onTransition={() => {}}
	onReconcileTags={() => {}}
/>
