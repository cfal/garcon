<script lang="ts">
	import type { SearchResultNavigationPort } from '$lib/sidebar/search/search-result-navigation-controller.js';
	import { searchNavigationPort } from './app-shell-search-navigation-test-port.js';
	import { getChatSessions, type WorkspaceChatActions } from '$lib/context';
	let {
		isMobile,
		onRegisterSearchNavigation,
		chatActions,
	}: {
		isMobile: boolean;
		onRegisterSearchNavigation?: (port: SearchResultNavigationPort) => () => void;
		chatActions: WorkspaceChatActions;
	} = $props();
	const sessions = getChatSessions();
	const firstChat = $derived(sessions.orderedChats[0]);
	$effect(() => onRegisterSearchNavigation?.(searchNavigationPort));
</script>

<div data-testid="workspace-root-stub" data-mobile={isMobile}>Workspace root</div>
{#if firstChat}
	<div data-conversation-panel data-conversation-panel-chat-id={firstChat.id}>
		<button data-chat-scroll-viewport>Transcript</button>
		<button onclick={() => firstChat && chatActions.requestParent(firstChat)}>Open parent picker</button>
	</div>
{/if}
