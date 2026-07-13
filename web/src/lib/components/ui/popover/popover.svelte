<script lang="ts">
	import { Popover as PopoverPrimitive } from 'bits-ui';
	import { setTransientLayerControl } from '../transient-layer-context';

	let {
		open = $bindable(false),
		onOpenChange,
		...restProps
	}: PopoverPrimitive.RootProps = $props();

	function updateOpen(nextOpen: boolean): void {
		open = nextOpen;
		onOpenChange?.(nextOpen);
	}

	setTransientLayerControl({ close: () => updateOpen(false) });
</script>

<PopoverPrimitive.Root bind:open onOpenChange={updateOpen} {...restProps} />
