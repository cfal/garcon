<script lang="ts">
	import { cn } from '$lib/utils/cn';
	import * as m from '$lib/paraglide/messages.js';

	let {
		statusId,
		class: className = 'h-3.5 w-3.5 shrink-0',
	}: {
		statusId: string;
		class?: string;
	} = $props();
</script>

<span
	class={cn('flex items-center justify-center', className)}
	data-slot="workspace-chat-processing-indicator"
>
	<span id={statusId} class="sr-only">{m.chat_window_processing()}</span>
	<span
		class="workspace-chat-processing-indicator size-2 rounded-full bg-status-processing"
		aria-hidden="true"
	></span>
</span>
