<script lang="ts" generics="Value extends string | number">
	import { cn } from '$lib/utils/cn';

	interface Option {
		readonly value: Value;
		readonly label: string;
	}

	interface Props {
		label: string;
		options: readonly Option[];
		value: Value;
		onChange: (value: Value) => void;
		class?: string;
	}

	let { label, options, value, onChange, class: className }: Props = $props();
</script>

<div
	role="group"
	aria-label={label}
	class={cn(
		'inline-flex shrink-0 items-center rounded-md border border-border bg-muted/40 p-0.5',
		className,
	)}
>
	{#each options as option (option.value)}
		<button
			type="button"
			aria-pressed={option.value === value}
			class={cn(
				'h-6 rounded-[5px] px-2 text-xs font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
				option.value === value && 'bg-background text-foreground shadow-xs',
			)}
			onclick={() => onChange(option.value)}
		>
			{option.label}
		</button>
	{/each}
</div>
