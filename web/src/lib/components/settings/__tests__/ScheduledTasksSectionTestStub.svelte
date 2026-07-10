<script lang="ts">
	let { active }: { active: boolean } = $props();
</script>

{#if active}<div>Scheduled tasks content</div>{/if}
