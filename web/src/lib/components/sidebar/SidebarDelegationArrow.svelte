<script lang="ts">
	let { depth }: { depth: number } = $props();
</script>

<span
	class="pointer-events-none max-w-[40%] shrink-0 truncate text-muted-foreground"
	aria-hidden="true"
	data-sidebar-delegation-arrow>{'\u21b3'.repeat(depth)}</span
>
