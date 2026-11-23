<script lang="ts">
	let { active, onEdit }: { active?: boolean; onEdit?: () => void } = $props();
</script>

<div data-testid="git-compare-panel-content" data-active={active}></div>
{#if onEdit}
	<button type="button" onclick={onEdit}>Edit comparison</button>
{/if}
