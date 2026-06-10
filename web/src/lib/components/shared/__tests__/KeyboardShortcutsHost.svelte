<script lang="ts">
	import KeyboardShortcuts from '../KeyboardShortcuts.svelte';
	import { setAppShell } from '$lib/context';

	interface KeyboardShortcutsHostProps {
		appShell: {
			openSidebarSearch: () => void;
			requestNewChat: () => void;
			requestRenameSelectedChat: () => void;
			requestDeleteSelectedChat: () => void;
			openSettings: () => void;
			requestNavigateChatAbove: () => void;
			requestNavigateChatBelow: () => void;
		};
		onToggleCommandMenu?: () => void;
	}

	let { appShell, onToggleCommandMenu }: KeyboardShortcutsHostProps = $props();

	setAppShell({
		get openSidebarSearch() {
			return appShell.openSidebarSearch;
		},
		get requestNewChat() {
			return appShell.requestNewChat;
		},
		get requestRenameSelectedChat() {
			return appShell.requestRenameSelectedChat;
		},
		get requestDeleteSelectedChat() {
			return appShell.requestDeleteSelectedChat;
		},
		get openSettings() {
			return appShell.openSettings;
		},
		get requestNavigateChatAbove() {
			return appShell.requestNavigateChatAbove;
		},
		get requestNavigateChatBelow() {
			return appShell.requestNavigateChatBelow;
		},
	} as never);
</script>

<KeyboardShortcuts {onToggleCommandMenu} />
