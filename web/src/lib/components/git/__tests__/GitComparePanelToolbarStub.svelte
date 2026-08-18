<script lang="ts">
	let { onEdit }: { onEdit: () => void } = $props();
</script>

<button type="button" onclick={onEdit}>Edit comparison</button>
