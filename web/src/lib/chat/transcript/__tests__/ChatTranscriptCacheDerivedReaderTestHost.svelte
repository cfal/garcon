<script lang="ts">
	import type { ChatTranscriptCache } from '../chat-transcript-cache.svelte.js';

	let { cache, chatId }: { cache: ChatTranscriptCache; chatId: string } = $props();
	const snapshot = $derived(cache.get(chatId));
</script>

<span data-testid="cached-last-ordinal">{snapshot?.lastOrdinal ?? 'missing'}</span>
