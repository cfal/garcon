<script lang="ts">
	import { Dialog as DialogPrimitive } from 'bits-ui';
	import { untrack } from 'svelte';
	import { getOptionalTransientLayers } from '$lib/context';
	import { setDialogLayerControl } from './dialog-layer-context';

	let {
		open = $bindable(false),
		onOpenChange,
		requestClose,
		...restProps
	}: DialogPrimitive.RootProps & { requestClose?: () => void } = $props();
	const transientLayers = getOptionalTransientLayers();
	const initiallyOpen = untrack(() => open);
	let wasOpen = initiallyOpen;
	let focusReturnTarget = activeElement();

	function activeElement(): HTMLElement | null {
		return typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
			? document.activeElement
			: null;
	}
	if (initiallyOpen && !transientLayers?.hasPendingMainInert) {
		transientLayers?.open('main-inert', () => undefined);
	}

	function updateOpen(next: boolean): void {
		if (!next && requestClose) {
			// Restores the controlled value before a synchronous request callback may close it.
			open = true;
			requestClose();
			return;
		}
		open = next;
		onOpenChange?.(next);
	}

	setDialogLayerControl({
		close: () => updateOpen(false),
		isOpen: () => open,
		focusReturnTarget: () => focusReturnTarget,
	});

	$effect.pre(() => {
		const nextOpen = open;
		if (nextOpen && !wasOpen) focusReturnTarget = activeElement();
		if (nextOpen && !wasOpen && !transientLayers?.hasPendingMainInert) {
			transientLayers?.open('main-inert', () => undefined);
		}
		wasOpen = nextOpen;
	});
</script>

<DialogPrimitive.Root bind:open onOpenChange={updateOpen} {...restProps} />
