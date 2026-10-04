<script lang="ts">
	interface Props {
		name: string;
		value: string;
		checked: boolean;
		onSelect: () => void;
		label: string;
		description?: string;
	}
	let { name, value, checked, onSelect, label, description }: Props = $props();
</script>

<label
	class="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors has-focus-visible:ring-2 has-focus-visible:ring-ring"
	class:border-foreground={checked}
	class:bg-accent={checked}
	class:border-border={!checked}
	class:hover:bg-muted={!checked}
>
	<input
		type="radio"
		{name}
		{value}
		{checked}
		onchange={onSelect}
		class="mt-0.5 size-4 shrink-0 accent-current"
	/>
	<span class="min-w-0">
		<span class="block text-sm font-medium text-foreground">{label}</span>
		{#if description}
			<span class="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{description}</span>
		{/if}
	</span>
</label>
