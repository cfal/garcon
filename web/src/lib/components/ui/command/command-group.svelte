<script lang="ts">
	import { Command as CommandPrimitive } from 'bits-ui';
	import { cn } from '$lib/utils/cn.js';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: CommandPrimitive.GroupProps = $props();
</script>

<CommandPrimitive.Group
	bind:ref
	data-slot="command-group"
	class={cn('overflow-hidden p-1 text-foreground', className)}
	{...restProps}
/>

