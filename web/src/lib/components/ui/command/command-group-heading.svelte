<script lang="ts">
	import { Command as CommandPrimitive } from 'bits-ui';
	import { cn } from '$lib/utils/cn.js';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: CommandPrimitive.GroupHeadingProps = $props();
</script>

<CommandPrimitive.GroupHeading
	bind:ref
	data-slot="command-group-heading"
	class={cn('px-2 py-1.5 text-xs font-medium text-muted-foreground', className)}
	{...restProps}
/>

