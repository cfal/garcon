<script lang="ts">
	import type { ChatSessionRecord } from '$lib/types/chat-session.js';
	import type { ConversationPanelActions } from '$lib/components/chat/conversation-panel-actions.js';
	import type { ChatViewSurfaceId } from '$lib/workspace/surface-types.js';

	let {
		chat,
		surfaceId,
		isCommandOwner,
		ownsComposer,
		actions,
		composerInsetPx = 0,
	}: {
		chat: ChatSessionRecord;
		surfaceId: ChatViewSurfaceId;
		isCommandOwner: boolean;
		ownsComposer: boolean;
		actions: ConversationPanelActions | null;
		composerInsetPx?: number;
	} = $props();
</script>

<button
	type="button"
	data-testid="conversation-panel"
	data-chat-id={chat.id}
	data-command-owner={isCommandOwner}
	data-owns-composer={ownsComposer}
	data-composer-inset={composerInsetPx}
	onclick={() => void actions?.pauseQueue(surfaceId, chat.id)}
>
	Panel {chat.id}
</button>
