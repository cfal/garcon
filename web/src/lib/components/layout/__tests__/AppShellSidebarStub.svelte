<script lang="ts">
	let {
		onChatSelect,
		onShowWorkMap,
	}: { onChatSelect: (chatId: string) => void; onShowWorkMap: () => void } = $props();
</script>

<button type="button" onclick={() => onChatSelect('chat-test')}>Select test chat</button>
<button type="button" onclick={onShowWorkMap}>Open Work Map from sidebar</button>
