<script lang="ts">
	import { onMount } from 'svelte';
	import type { UserMessageNavigatorRegistration } from '$lib/chat/transcript/user-message-navigator-controller.svelte.js';

	let {
		reserveTopFloatingToolbar,
		onRegisterUserMessageNavigator,
	}: {
		reserveTopFloatingToolbar: boolean;
		onRegisterUserMessageNavigator?: (command: UserMessageNavigatorRegistration) => void;
	} = $props();
	let navigatorOpenCount = $state(0);

	onMount(() => {
		onRegisterUserMessageNavigator?.(() => {
			navigatorOpenCount += 1;
		});
		return () => onRegisterUserMessageNavigator?.(null);
	});
</script>

<div
	data-testid="chat-surface-stub"
	data-reserve-top-floating-toolbar={reserveTopFloatingToolbar}
	data-navigator-open-count={navigatorOpenCount}
>
	Chat surface
	<input aria-label="Chat focus target" />
</div>
