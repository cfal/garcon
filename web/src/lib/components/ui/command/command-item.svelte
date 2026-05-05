<script lang="ts">
	import { Command as CommandPrimitive } from 'bits-ui';
	import { cn } from '$lib/utils/cn.js';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: CommandPrimitive.ItemProps = $props();
</script>

<CommandPrimitive.Item
	bind:ref
	data-slot="command-item"
	class={cn(
		"data-[selected]:bg-accent data-[selected]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
		className
	)}
	{...restProps}
/>

