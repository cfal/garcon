<script lang="ts">
	import { Select as SelectPrimitive } from 'bits-ui';
	import { setTransientLayerControl } from '../transient-layer-context';

	let {
		open = $bindable(false),
		value = $bindable(),
		type,
		onOpenChange,
		onValueChange,
		...restProps
	}: SelectPrimitive.RootProps = $props();
	function updateOpen(nextOpen: boolean): void {
		open = nextOpen;
		onOpenChange?.(nextOpen);
	}

	function updateValue(nextValue: string | string[]): void {
		value = nextValue;
		const notifyValueChange = onValueChange as
			| ((updatedValue: string | string[]) => void)
			| undefined;
		notifyValueChange?.(nextValue);
	}

	setTransientLayerControl({ close: () => updateOpen(false) });
</script>

{#if type === 'single'}
	<SelectPrimitive.Root
		{...restProps}
		type="single"
		{open}
		value={typeof value === 'string' ? value : undefined}
		onOpenChange={updateOpen}
		onValueChange={updateValue}
	/>
{:else}
	<SelectPrimitive.Root
		{...restProps}
		type="multiple"
		{open}
		value={Array.isArray(value) ? value : undefined}
		onOpenChange={updateOpen}
		onValueChange={updateValue}
	/>
{/if}
