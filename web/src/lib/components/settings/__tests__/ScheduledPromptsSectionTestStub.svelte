<script lang="ts">
	let { active }: { active: boolean } = $props();
</script>

{#if active}<div>Scheduled prompts content</div>{/if}
