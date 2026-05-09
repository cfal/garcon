<script lang="ts">
	interface ConversationWorkspaceStubProps {
		reserveTopFloatingToolbar?: boolean;
	}

	let { reserveTopFloatingToolbar = false }: ConversationWorkspaceStubProps = $props();
</script>

<div
	data-testid="conversation-workspace-stub"
	data-reserve-top-floating-toolbar={reserveTopFloatingToolbar ? 'true' : 'false'}
>
	Conversation workspace stub
</div>
