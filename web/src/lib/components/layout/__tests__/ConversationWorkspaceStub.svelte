<script module lang="ts">
	let nextInstanceId = 0;

	function createInstanceId(): number {
		nextInstanceId += 1;
		return nextInstanceId;
	}
</script>

<script lang="ts">
	interface ConversationWorkspaceStubProps {
		reserveTopFloatingToolbar?: boolean;
		getVisibleChatIds?: () => string[];
		isVisiblePreviewChat?: (chatId: string) => boolean;
		getVisiblePreviewCursor?: (chatId: string) => unknown;
		applyVisiblePreviewMessages?: (...args: unknown[]) => unknown;
		loadVisiblePreviewSnapshot?: (chatId: string) => unknown;
		markVisiblePreviewStale?: (chatId: string) => unknown;
		textScale?: number;
		isVisible?: boolean;
	}

	let {
		reserveTopFloatingToolbar = false,
		textScale = 1,
		isVisible = true,
	}: ConversationWorkspaceStubProps = $props();

	const instanceId = createInstanceId();
</script>

<div
	data-testid="conversation-workspace-stub"
	data-instance-id={String(instanceId)}
	data-reserve-top-floating-toolbar={reserveTopFloatingToolbar ? 'true' : 'false'}
	data-text-scale={String(textScale)}
	data-is-visible={isVisible ? 'true' : 'false'}
>
	Conversation workspace stub
</div>
