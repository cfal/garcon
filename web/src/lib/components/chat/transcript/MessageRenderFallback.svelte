<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';

	interface MessageRenderFallbackProps {
		error?: unknown;
	}

	let { error }: MessageRenderFallbackProps = $props();

	const fallbackText = $derived(
		error instanceof Error
			? `${m.chat_message_render_failed()}: ${error.message}`
			: m.chat_message_render_failed(),
	);
</script>

<div
	class="px-4 py-2 text-sm text-destructive bg-destructive/10 rounded border border-destructive/20"
>
	{fallbackText}
</div>
