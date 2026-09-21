<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import ChatProcessingIndicator from '$lib/components/chat/ChatProcessingIndicator.svelte';
	import { cn } from '$lib/utils/cn.js';

	let {
		statusId,
		sizePx,
		class: className = sizePx === undefined ? 'h-3.5 w-3.5 shrink-0' : 'shrink-0',
	}: {
		statusId: string;
		sizePx?: number;
		class?: string;
	} = $props();
</script>

<span
	class={cn('flex items-center justify-center', className)}
	style:height={sizePx === undefined ? undefined : `${sizePx}px`}
	style:width={sizePx === undefined ? undefined : `${sizePx}px`}
	data-slot="workspace-chat-processing-indicator"
>
	<ChatProcessingIndicator
		phase="running"
		label={m.chat_window_processing()}
		{statusId}
		dotClass="workspace-chat-processing-indicator"
		dotSlot="workspace-chat-processing-indicator-dot"
		dotSizePx={sizePx === undefined ? undefined : sizePx - 6}
	/>
</span>
