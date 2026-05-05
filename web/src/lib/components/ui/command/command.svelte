<script lang="ts">
	import { Command as CommandPrimitive } from 'bits-ui';
	import { cn } from '$lib/utils/cn.js';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: CommandPrimitive.RootProps = $props();
</script>

<CommandPrimitive.Root
	bind:ref
	data-slot="command"
	class={cn('flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground', className)}
	{...restProps}
/>

