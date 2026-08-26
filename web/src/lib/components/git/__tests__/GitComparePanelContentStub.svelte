<script lang="ts">
	let { onEdit }: { onEdit?: () => void } = $props();
</script>

<div data-testid="git-compare-panel-content"></div>
{#if onEdit}
	<button type="button" onclick={onEdit}>Edit comparison</button>
{/if}
