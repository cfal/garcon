<script lang="ts">
	import { onDestroy } from 'svelte';
	import { setLocalSettings, setMinuteClock } from '$lib/context';
	import { createLocalSettingsStore } from '$lib/stores/local-settings.svelte.js';
	import { MinuteClockStore } from '$lib/stores/minute-clock.svelte.js';
	import type { ChatBoardController } from '$lib/chat-board/catalog/chat-board-controller.svelte.js';
	import type { ChatSessionsPort } from '$lib/chat/sessions/chat-sessions-contract.js';
	import ChatBoardPanel from '../ChatBoardPanel.svelte';

	let {
		controller,
		sessions,
		onOpenChat,
		currentTime = new Date(),
	}: {
		controller: ChatBoardController;
		sessions: ChatSessionsPort;
		onOpenChat: (chatId: string) => void;
		currentTime?: Date;
	} = $props();

	const localSettings = createLocalSettingsStore();
	const minuteClock = new MinuteClockStore();
	setLocalSettings(localSettings);
	setMinuteClock(minuteClock);
	$effect(() => {
		minuteClock.currentTime = currentTime;
	});
	onDestroy(() => {
		localSettings.destroy();
		minuteClock.destroy();
	});
</script>

<ChatBoardPanel {controller} {sessions} presentation="window-main" {onOpenChat} />
