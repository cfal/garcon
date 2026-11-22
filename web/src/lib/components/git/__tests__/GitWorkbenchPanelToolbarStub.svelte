<script lang="ts">
	let { onCommit, onPush }: { onCommit: () => void; onPush: () => void } = $props();
</script>

<button type="button" onclick={onCommit}>Commit</button>
<button type="button" onclick={onPush}>Push</button>
