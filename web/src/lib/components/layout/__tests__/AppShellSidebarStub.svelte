<script lang="ts">
	let { onChatSelect, onShowWorkflows }: {
		onChatSelect: (chatId: string) => void;
		onShowWorkflows?: () => void;
	} = $props();
</script>

<button type="button" onclick={() => onChatSelect('chat-test')}>Select test chat</button>
{#if onShowWorkflows}<button type="button" onclick={onShowWorkflows}>Open workflows</button>{/if}
