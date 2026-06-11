<script lang="ts">
	import { cn } from '$lib/utils/cn';
	import { getTagColorClasses } from '$lib/utils/tag-colors';

	interface ColoredTagProps {
		label: string;
		variant?: string;
		autoColor?: boolean;
		onclick?: (e: MouseEvent) => void;
		class?: string;
	}

	let {
		label,
		variant = '',
		autoColor = false,
		onclick,
		class: className,
	}: ColoredTagProps = $props();

	let resolvedVariant = $derived(variant || (autoColor ? getTagColorClasses(label) : ''));
</script>

{#if onclick}
	<button
		type="button"
		class={cn(
			'inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold leading-none',
			resolvedVariant,
			className,
		)}
		{onclick}
	>
		{label}
	</button>
{:else}
	<span
		class={cn(
			'inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold leading-none',
			resolvedVariant,
			className,
		)}
	>
		{label}
	</span>
{/if}
