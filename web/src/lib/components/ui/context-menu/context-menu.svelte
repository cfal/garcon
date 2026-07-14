<script lang="ts">
	import { ContextMenu as ContextMenuPrimitive } from 'bits-ui';
	import { setTransientLayerControl } from '../transient-layer-context';

	let {
		open = $bindable(false),
		onOpenChange,
		...restProps
	}: ContextMenuPrimitive.RootProps = $props();

	function updateOpen(nextOpen: boolean): void {
		open = nextOpen;
		onOpenChange?.(nextOpen);
	}

	setTransientLayerControl({ close: () => updateOpen(false) });
</script>

<ContextMenuPrimitive.Root bind:open onOpenChange={updateOpen} {...restProps} />
