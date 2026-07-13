<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { getWorkspaceShortcuts } from '$lib/context';

	interface KeyboardShortcutsProps {
		onToggleCommandMenu?: () => void;
	}

	let { onToggleCommandMenu }: KeyboardShortcutsProps = $props();

	const shortcuts = getWorkspaceShortcuts();
	const handleKeydown = (event: KeyboardEvent) => shortcuts.handle(event);

	onMount(() => {
		shortcuts.setCommandMenuHandler(onToggleCommandMenu ?? null);
		window.addEventListener('keydown', handleKeydown, { capture: true });
	});

	onDestroy(() => {
		shortcuts.setCommandMenuHandler(null);
		window.removeEventListener('keydown', handleKeydown, { capture: true });
	});
</script>
