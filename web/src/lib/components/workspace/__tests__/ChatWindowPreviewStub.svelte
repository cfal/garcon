<script lang="ts">
	let { chatId }: { chatId: string } = $props();
</script>

<button type="button" data-testid="chat-window-preview" data-chat-id={chatId}>
	Preview {chatId}
</button>
