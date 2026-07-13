<script lang="ts">
	import { Select as SelectPrimitive } from 'bits-ui';
	import { setTransientLayerControl } from '../transient-layer-context';

	let {
		open = $bindable(false),
		value = $bindable(),
		onOpenChange,
		...restProps
	}: SelectPrimitive.RootProps = $props();

	function updateOpen(nextOpen: boolean): void {
		open = nextOpen;
		onOpenChange?.(nextOpen);
	}

	setTransientLayerControl({ close: () => updateOpen(false) });
</script>

<SelectPrimitive.Root bind:open bind:value={value as never} onOpenChange={updateOpen} {...restProps} />
