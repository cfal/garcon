<script lang="ts">
	let { chatId, textScale, onFocus }: { chatId: string; textScale: number; onFocus: () => void } =
		$props();
</script>

<button
	type="button"
	data-testid="chat-window-preview"
	data-chat-id={chatId}
	data-text-scale={textScale}
	onclick={onFocus}
>
	Preview {chatId}
</button>
