<script lang="ts">
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import * as m from '$lib/paraglide/messages.js';
	import type { ChatMapMissingParentNode } from '$lib/chat-map/chat-map-model';

	let { node }: { node: ChatMapMissingParentNode } = $props();
</script>

<article
	class="min-w-0 flex-1 rounded-lg border border-status-warning-border bg-status-warning/10 px-3 py-2.5 text-status-warning-muted-foreground"
	data-chat-map-missing-parent={node.chatId}
>
	<div class="flex items-start gap-2">
		<CircleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
		<div class="min-w-0">
			<p class="text-sm font-semibold">{m.chat_map_missing_parent()}</p>
			<p class="mt-0.5 break-all text-xs">
				{m.chat_map_missing_parent_detail({ chatId: node.chatId })}
			</p>
		</div>
	</div>
</article>
