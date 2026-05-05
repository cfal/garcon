<script lang="ts">
	import { Command as CommandPrimitive } from 'bits-ui';
	import { cn } from '$lib/utils/cn.js';

	let {
		ref = $bindable(null),
		value = $bindable(''),
		class: className,
		...restProps
	}: CommandPrimitive.InputProps = $props();
</script>

<CommandPrimitive.Input
	bind:ref
	bind:value
	data-slot="command-input"
	class={cn(
		'flex h-9 w-full rounded-md bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
		className
	)}
	{...restProps}
/>

