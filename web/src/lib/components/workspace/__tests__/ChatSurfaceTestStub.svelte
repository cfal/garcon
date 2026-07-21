<script lang="ts">
	let { reserveTopFloatingToolbar }: { reserveTopFloatingToolbar: boolean } = $props();
</script>

<div data-testid="chat-surface-stub" data-reserve-top-floating-toolbar={reserveTopFloatingToolbar}>
	Chat surface
	<input aria-label="Chat focus target" />
</div>
