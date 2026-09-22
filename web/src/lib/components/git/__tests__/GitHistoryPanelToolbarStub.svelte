<script lang="ts">
	let { onRefresh }: { onRefresh: () => void } = $props();
</script>

<button type="button" onclick={onRefresh}>Refresh</button>
