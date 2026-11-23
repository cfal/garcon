<script lang="ts">
	let {
		label,
		value,
		wrapValue = false,
	}: { label: string; value: string; wrapValue?: boolean } = $props();
</script>

<span class="min-w-0 flex-1 text-start">
	<span class="block font-medium">{label}</span>
	<span
		data-menu-description
		class="block text-xs text-muted-foreground group-data-[highlighted]:text-accent-foreground {wrapValue
			? 'whitespace-normal wrap-anywhere'
			: 'truncate'}"
		title={value}>{value}</span
	>
</span>
