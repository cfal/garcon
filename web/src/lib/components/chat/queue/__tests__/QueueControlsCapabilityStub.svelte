<script lang="ts">
	let { canSteer = false }: { canSteer?: boolean } = $props();
</script>

<div data-testid="queue-can-steer">{String(canSteer)}</div>
