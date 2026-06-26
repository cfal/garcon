<script lang="ts">
	interface Props {
		paneId: string;
		chatId: string;
	}

	let { paneId, chatId }: Props = $props();
</script>

<div data-testid="chat-pane-stub" data-pane-id={paneId}>{chatId}</div>
