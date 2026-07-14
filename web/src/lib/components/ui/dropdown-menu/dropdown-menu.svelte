<script lang="ts">
	import { DropdownMenu as DropdownMenuPrimitive } from 'bits-ui';
	import { setTransientLayerControl } from '../transient-layer-context';

	let {
		open = $bindable(false),
		onOpenChange,
		...restProps
	}: DropdownMenuPrimitive.RootProps = $props();

	function updateOpen(nextOpen: boolean): void {
		open = nextOpen;
		onOpenChange?.(nextOpen);
	}

	setTransientLayerControl({ close: () => updateOpen(false) });
</script>

<DropdownMenuPrimitive.Root bind:open onOpenChange={updateOpen} {...restProps} />
