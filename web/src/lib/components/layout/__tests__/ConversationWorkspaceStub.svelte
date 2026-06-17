<script lang="ts">
	interface ConversationWorkspaceStubProps {
		reserveTopFloatingToolbar?: boolean;
		getVisibleChatIds?: () => string[];
		isVisiblePreviewChat?: (chatId: string) => boolean;
		getVisiblePreviewCursor?: (chatId: string) => unknown;
		applyVisiblePreviewMessages?: (...args: unknown[]) => unknown;
		loadVisiblePreviewSnapshot?: (chatId: string) => unknown;
		markVisiblePreviewStale?: (chatId: string) => unknown;
	}

	let { reserveTopFloatingToolbar = false }: ConversationWorkspaceStubProps = $props();
</script>

<div
	data-testid="conversation-workspace-stub"
	data-reserve-top-floating-toolbar={reserveTopFloatingToolbar ? 'true' : 'false'}
>
	Conversation workspace stub
</div>
