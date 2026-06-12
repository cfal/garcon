<script lang="ts">
	// Global keyboard shortcut handler. Mounted in the root layout or
	// AppShell to capture cross-cutting shortcuts like Ctrl+P (command
	// palette) and Ctrl+, (settings).
	//
	// Listener pattern: always-on listeners use onMount/onDestroy pairs.
	// Conditional listeners use $effect with a cleanup return.

	import { onMount, onDestroy } from 'svelte';
	import { getAppShell, getNavigation } from '$lib/context';

	interface KeyboardShortcutsProps {
		onToggleCommandMenu?: () => void;
	}

	let { onToggleCommandMenu }: KeyboardShortcutsProps = $props();

	const appShell = getAppShell();
	const navigation = getNavigation();

	function isEditableTarget(target: EventTarget | null): boolean {
		const element = target as HTMLElement | null;
		if (!element) return false;
		return (
			element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable
		);
	}

	function handleKeydown(e: KeyboardEvent) {
		const key = e.key.toLowerCase();
		const isMeta = e.metaKey || e.ctrlKey;
		const inEditable = isEditableTarget(e.target);

		// Allow command-menu/search/new-chat/rename shortcuts even inside inputs.
		if (isMeta && key === 'p') {
			e.preventDefault();
			onToggleCommandMenu?.();
			return;
		}
		if (isMeta && key === 's') {
			e.preventDefault();
			appShell.openSidebarSearch();
			return;
		}
		if (e.ctrlKey && key === 'n') {
			e.preventDefault();
			appShell.requestNewChat();
			return;
		}
		if (e.ctrlKey && key === 'r') {
			e.preventDefault();
			appShell.requestRenameSelectedChat();
			return;
		}
		if (e.ctrlKey && key === 'd') {
			e.preventDefault();
			appShell.requestDeleteSelectedChat();
			return;
		}
		if (e.ctrlKey && e.shiftKey && key === 'j') {
			e.preventDefault();
			navigation.requestNavigateChatAbove();
			return;
		}
		if (e.ctrlKey && e.shiftKey && key === 'l') {
			e.preventDefault();
			navigation.requestNavigateChatBelow();
			return;
		}
		if (inEditable) return;

		// Ctrl+, -- open settings
		if (e.ctrlKey && key === ',') {
			e.preventDefault();
			appShell.openSettings();
			return;
		}
	}

	onMount(() => {
		window.addEventListener('keydown', handleKeydown);
	});

	onDestroy(() => {
		window.removeEventListener('keydown', handleKeydown);
	});
</script>
