<script lang="ts">
	import type { NewChatDialogSeed } from '$lib/chat/new-chat/new-chat-seed';
	let { active, onOpenInNewChat }: { active: boolean; onOpenInNewChat: (seed: NewChatDialogSeed) => void } = $props();
</script>

{#if active}
	<div>Scheduled prompts content</div>
	<button onclick={() => onOpenInNewChat({ prefill: 'Synthetic prompt' })}>Open in new chat</button>
{/if}
