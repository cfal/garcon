<script lang="ts">
	let {
		scrollContainer = $bindable<HTMLDivElement | null>(null),
		onViewportPortChange,
	}: {
		scrollContainer?: HTMLDivElement | null;
		onViewportPortChange?: (port: null) => void;
	} = $props();
</script>

<div data-testid="conversation-feed-stub" bind:this={scrollContainer}>
	<button onclick={() => onViewportPortChange?.(null)}>register viewport</button>
</div>
