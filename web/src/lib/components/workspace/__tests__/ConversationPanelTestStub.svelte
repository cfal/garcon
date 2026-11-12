<script module lang="ts">
	import type { ConversationPanelRegistration } from '$lib/chat/conversation/conversation-panel-registry.svelte.js';
	export const panelMounts: { panel: ConversationPanelRegistration; visible: boolean }[] = [];
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types.js';
	import type { ConversationPanelActions } from '$lib/components/chat/conversation-panel-actions.js';
	import type { ChatViewSurfaceId } from '$lib/workspace/surface-types.js';

	let {
		chat,
		panel,
		surfaceId,
		isCommandOwner,
		ownsComposer,
		actions,
		composerInsetPx = 0,
	}: {
		chat: ChatSessionRecord;
		panel: ConversationPanelRegistration;
		surfaceId: ChatViewSurfaceId;
		isCommandOwner: boolean;
		ownsComposer: boolean;
		actions: ConversationPanelActions | null;
		composerInsetPx?: number;
	} = $props();
	untrack(() => panelMounts.push({ panel, visible: panel.isPresentationVisible }));
</script>

<button
	type="button"
	data-testid="conversation-panel"
	data-chat-id={chat.id}
	data-transcript-view-id={panel.transcript.transcriptViewId}
	data-panel-pinned={panel.scroll.isPinnedToBottom}
	data-command-owner={isCommandOwner}
	data-owns-composer={ownsComposer}
	data-composer-inset={composerInsetPx}
	onclick={() => void actions?.pauseQueue(surfaceId, chat.id)}
>
	Panel {chat.id}
</button>
