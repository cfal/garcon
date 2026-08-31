<script lang="ts">
	let {
		onChatSelect,
		onShowChatMap,
	}: { onChatSelect: (chatId: string) => void; onShowChatMap: () => void } = $props();
</script>

<button type="button" onclick={() => onChatSelect('chat-test')}>Select test chat</button>
<button type="button" onclick={onShowChatMap}>Open chat map from sidebar</button>
