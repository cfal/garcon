<script lang="ts">
	let {
		isMobile,
		chatListConsumesWorkspaceWidth,
		canEnableChatListAutohide,
		onEnableChatListAutohide,
	}: {
		isMobile: boolean;
		chatListConsumesWorkspaceWidth: boolean;
		canEnableChatListAutohide: boolean;
		onEnableChatListAutohide: () => void;
	} = $props();
</script>

<div
	data-testid="workspace-root-stub"
	data-mobile={isMobile}
	data-chat-list-consumes-width={chatListConsumesWorkspaceWidth}
	data-can-enable-chat-list-autohide={canEnableChatListAutohide}
>
	Workspace root
	<button type="button" onclick={onEnableChatListAutohide}>Enable auto-hide from workspace</button>
</div>
