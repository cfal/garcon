<script lang="ts">
	let { open }: { open: boolean } = $props();
</script>

{#if open}<div>Scheduled prompt editor</div>{/if}
