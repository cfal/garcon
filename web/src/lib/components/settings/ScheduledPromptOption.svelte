<script lang="ts" generics="Value extends string">
	interface Props {
		name: string;
		value: Value;
		group: Value;
		label: string;
		description?: string;
	}
	let { name, value, group = $bindable(), label, description }: Props = $props();
</script>

<label
	class="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors has-focus-visible:ring-2 has-focus-visible:ring-ring"
	class:border-foreground={group === value}
	class:bg-accent={group === value}
	class:border-border={group !== value}
	class:hover:bg-muted={group !== value}
>
	<input type="radio" {name} {value} bind:group class="mt-0.5 size-4 shrink-0 accent-current" />
	<span class="min-w-0">
		<span class="block text-sm font-medium text-foreground">{label}</span>
		{#if description}
			<span class="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{description}</span>
		{/if}
	</span>
</label>
