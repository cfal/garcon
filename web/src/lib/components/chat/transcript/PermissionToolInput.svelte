<script lang="ts">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import type { ToolUseChatMessage } from '$shared/chat-types';
	import { getToolDisplayDetails } from '$lib/chat/tools/tool-display-registry.js';
	import * as m from '$lib/paraglide/messages.js';

	let { tool, open, onOpenChange }: {
		tool: ToolUseChatMessage;
		open: boolean;
		onOpenChange: (next: boolean) => void;
	} = $props();
</script>

<details
	class="mt-1"
	{open}
	ontoggle={(event) => {
		const next = event.currentTarget.open;
		if (next !== open) onOpenChange(next);
	}}
>
	<summary class="cursor-pointer text-xs opacity-80 flex items-center gap-1 select-none">
		<ChevronDown class="w-3.5 h-3.5" />
		{m.chat_permission_view_tool_input()}
	</summary>
	{#if open}
		<pre class="typography-chat-code mt-2 max-h-40 overflow-auto rounded-md border border-current/20 bg-background/50 p-2 text-xs font-mono whitespace-pre-wrap">{JSON.stringify(getToolDisplayDetails(tool), null, 2)}</pre>
	{/if}
</details>
