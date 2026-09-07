<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { getWorkspaceShortcuts } from '$lib/context';

	interface KeyboardShortcutsProps {
		onToggleCommandMenu?: () => void;
	}

	let { onToggleCommandMenu }: KeyboardShortcutsProps = $props();

	const shortcuts = getWorkspaceShortcuts();
	const handleKeydown = (event: KeyboardEvent) => {
		shortcuts.noteUserInteraction();
		shortcuts.handle(event);
	};
	const noteFocusInteraction = (event: FocusEvent) =>
		shortcuts.noteScrollRegionInteraction(event.target, 'focus');
	const notePointerInteraction = (event: PointerEvent) => {
		shortcuts.noteUserInteraction();
		shortcuts.noteScrollRegionInteraction(event.target, 'pointer');
	};
	const noteWheelInteraction = (event: WheelEvent) =>
		shortcuts.noteScrollRegionInteraction(event.target, 'wheel');

	onMount(() => {
		shortcuts.setCommandMenuHandler(onToggleCommandMenu ?? null);
		window.addEventListener('keydown', handleKeydown, { capture: true });
		window.addEventListener('focusin', noteFocusInteraction, { capture: true });
		window.addEventListener('pointerdown', notePointerInteraction, {
			capture: true,
			passive: true,
		});
		window.addEventListener('wheel', noteWheelInteraction, {
			capture: true,
			passive: true,
		});
	});

	onDestroy(() => {
		shortcuts.setCommandMenuHandler(null);
		window.removeEventListener('keydown', handleKeydown, { capture: true });
		window.removeEventListener('focusin', noteFocusInteraction, { capture: true });
		window.removeEventListener('pointerdown', notePointerInteraction, { capture: true });
		window.removeEventListener('wheel', noteWheelInteraction, { capture: true });
	});
</script>
