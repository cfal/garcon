<script lang="ts">
	import KeyboardShortcuts from '../KeyboardShortcuts.svelte';
	import { setAppShell } from '$lib/context';

	interface KeyboardShortcutsHarnessProps {
		appShell: {
			openSidebarSearch: () => void;
			requestNewChat: () => void;
			requestRenameSelectedChat: () => void;
			requestDeleteSelectedChat: () => void;
			openSettings: () => void;
		};
		onToggleCommandMenu?: () => void;
	}

	let { appShell, onToggleCommandMenu }: KeyboardShortcutsHarnessProps = $props();

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
</script>

<KeyboardShortcuts {onToggleCommandMenu} />
