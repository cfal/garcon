<script lang="ts">
	let { label, value }: { label: string; value: string } = $props();
</script>

<span class="min-w-0 flex-1 text-start">
	<span class="block font-medium">{label}</span>
	<span
		data-menu-description
		class="block truncate text-xs text-muted-foreground group-data-[highlighted]:text-accent-foreground"
		title={value}>{value}</span
	>
</span>
