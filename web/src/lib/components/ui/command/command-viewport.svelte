<script lang="ts">
	import { Command as CommandPrimitive } from 'bits-ui';
	import { cn } from '$lib/utils/cn.js';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: CommandPrimitive.ViewportProps = $props();
</script>

<CommandPrimitive.Viewport
	bind:ref
	data-slot="command-viewport"
	class={cn('h-full w-full', className)}
	{...restProps}
/>

