<script lang="ts">
	let { onCommit }: { onCommit: () => void } = $props();
</script>

<button type="button" onclick={onCommit}>Commit</button>
