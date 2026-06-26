<script lang="ts">
	interface Props {
		paneId: string;
		chatId: string;
		onMaximize: () => void;
	}

	let { paneId, chatId, onMaximize }: Props = $props();
</script>

<div data-testid="chat-pane-stub" data-pane-id={paneId}>
	{chatId}
	<button type="button" aria-label={`Maximize ${paneId}`} onclick={onMaximize}>Maximize</button>
</div>
