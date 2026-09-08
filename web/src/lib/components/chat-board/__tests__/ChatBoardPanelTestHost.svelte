<script lang="ts">
	import { onDestroy } from 'svelte';
	import { setLocalSettings, setMinuteClock } from '$lib/context';
	import { createLocalSettingsStore } from '$lib/stores/local-settings.svelte.js';
	import { MinuteClockStore } from '$lib/stores/minute-clock.svelte.js';
	import {
		setSurfaceFrameBridge,
		SurfaceFrameBridge,
	} from '$lib/workspace/surface-frame-context.js';
	import type { ChatBoardController } from '$lib/chat-board/catalog/chat-board-controller.svelte.js';
	import type { ChatSessionsPort } from '$lib/chat/sessions/chat-sessions-contract.js';
	import type { PresentationHostId } from '$lib/workspace/surface-types.js';
	import ChatBoardPanel from '../ChatBoardPanel.svelte';

	let {
		controller,
		sessions,
		onOpenChat,
		currentTime = new Date(),
		presentation = 'window-main',
	}: {
		controller: ChatBoardController;
		sessions: ChatSessionsPort;
		onOpenChat: (chatId: string) => void;
		currentTime?: Date;
		presentation?: PresentationHostId;
	} = $props();

	const localSettings = createLocalSettingsStore();
	const minuteClock = new MinuteClockStore();
	const frameBridge = new SurfaceFrameBridge();
	setLocalSettings(localSettings);
	setMinuteClock(minuteClock);
	setSurfaceFrameBridge(() => frameBridge);
	$effect(() => {
		minuteClock.currentTime = currentTime;
	});
	onDestroy(() => {
		localSettings.destroy();
		minuteClock.destroy();
	});
</script>

<ChatBoardPanel {controller} {sessions} {presentation} {onOpenChat} />
