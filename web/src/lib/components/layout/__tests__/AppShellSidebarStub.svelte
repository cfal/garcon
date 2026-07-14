<script lang="ts">
	let { onChatSelect }: { onChatSelect: (chatId: string) => void } = $props();
</script>

<button type="button" onclick={() => onChatSelect('chat-test')}>Select test chat</button>
