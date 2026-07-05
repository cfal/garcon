<script lang="ts">
	let {
		scrollContainer = $bindable<HTMLDivElement | null>(null),
		scrollContentContainer = $bindable<HTMLDivElement | null>(null),
	}: {
		scrollContainer?: HTMLDivElement | null;
		scrollContentContainer?: HTMLDivElement | null;
	} = $props();
</script>

<div data-testid="conversation-feed-stub" bind:this={scrollContainer}>
	<div bind:this={scrollContentContainer}></div>
</div>
