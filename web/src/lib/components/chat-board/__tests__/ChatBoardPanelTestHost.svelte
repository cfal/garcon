<script lang="ts">
	import { onDestroy } from 'svelte';
	import { setLocalSettings } from '$lib/context';
	import { createLocalSettingsStore } from '$lib/stores/local-settings.svelte.js';
	import type { ChatBoardController } from '$lib/chat-board/catalog/chat-board-controller.svelte.js';
	import type { ChatSessionsPort } from '$lib/chat/sessions/chat-sessions.svelte.js';
	import ChatBoardPanel from '../ChatBoardPanel.svelte';

	let {
		controller,
		sessions,
		onOpenChat,
	}: {
		controller: ChatBoardController;
		sessions: ChatSessionsPort;
		onOpenChat: (chatId: string) => void;
	} = $props();

	const localSettings = createLocalSettingsStore();
	setLocalSettings(localSettings);
	onDestroy(() => localSettings.destroy());
</script>

<ChatBoardPanel {controller} {sessions} presentation="window-main" {onOpenChat} />
