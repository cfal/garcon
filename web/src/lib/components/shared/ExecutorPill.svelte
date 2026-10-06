<script lang="ts">
	// Read-only label naming the executor a surface targets.

	import type { HTMLAttributes } from 'svelte/elements';
	import Network from '@lucide/svelte/icons/network';
	import * as m from '$lib/paraglide/messages.js';
	import { cn } from '$lib/utils/cn.js';

	interface Props extends HTMLAttributes<HTMLSpanElement> {
		label: string;
	}

	let { label, class: className, ...rest }: Props = $props();
	const description = $derived(m.executors_named_label({ label }));
</script>

<span
	{...rest}
	class={cn(
		'flex w-fit min-w-0 max-w-full items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground',
		className,
	)}
	title={description}
>
	<Network class="size-3 shrink-0 text-file-icon-folder" aria-hidden="true" />
	<span class="sr-only">{description}</span>
	<span class="truncate" aria-hidden="true">{label}</span>
</span>
