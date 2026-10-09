<script lang="ts">
	import { cn, type WithElementRef, type WithoutChildren } from '$lib/utils/cn.js';
	import type { HTMLTextareaAttributes } from 'svelte/elements';
	import { contentSizedTextarea } from './content-sized-textarea.svelte.js';

	let {
		ref = $bindable(null),
		value = $bindable(),
		class: className,
		autoSize = true,
		'data-slot': dataSlot = 'textarea',
		...restProps
	}: WithoutChildren<WithElementRef<HTMLTextareaAttributes>> & { autoSize?: boolean } = $props();
	const contentSizing = contentSizedTextarea(() => value);
</script>

<textarea
	{@attach autoSize && contentSizing}
	rows="1"
	bind:this={ref}
	data-slot={dataSlot}
	class={cn(
		'border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 flex w-full rounded-(--control-radius) border bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 md:pointer-fine:text-sm',
		autoSize ? 'content-sized-textarea' : 'min-h-16',
		className,
	)}
	bind:value
	{...restProps}></textarea>
