<script lang="ts">
	import KeyboardShortcuts from '../KeyboardShortcuts.svelte';
	import { setAppShell, setNavigation } from '$lib/context';

	interface KeyboardShortcutsHostProps {
		appShell: {
			openSidebarSearch: () => void;
			requestNewChat: () => void;
			requestRenameSelectedChat: () => void;
			requestDeleteSelectedChat: () => void;
			openSettings: () => void;
		};
		navigation: {
			requestNavigateChatAbove: () => void;
			requestNavigateChatBelow: () => void;
		};
		onToggleCommandMenu?: () => void;
	}

	let { appShell, navigation, onToggleCommandMenu }: KeyboardShortcutsHostProps = $props();

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
	} as never);

	setNavigation({
		get requestNavigateChatAbove() {
			return navigation.requestNavigateChatAbove;
		},
		get requestNavigateChatBelow() {
			return navigation.requestNavigateChatBelow;
		},
	} as never);
</script>

<KeyboardShortcuts {onToggleCommandMenu} />
