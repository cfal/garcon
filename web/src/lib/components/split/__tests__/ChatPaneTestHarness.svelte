<script lang="ts">
	import ChatPane from '../ChatPane.svelte';
	import { setChatSessions, setSplitLayout, setWs } from '$lib/context';

	interface Props {
		isFocused?: boolean;
		onFocus?: () => void;
	}

	let { isFocused = false, onFocus = () => {} }: Props = $props();

	setChatSessions({
		byId: {
			'chat-1': {
				id: 'chat-1',
				title: 'Pane Test Chat',
				provider: 'codex',
				isProcessing: false,
			},
		},
	} as never);

	setWs({
		isConnected: true,
		sendRequest: () => Promise.resolve({
			messages: [
				{
					type: 'user-message',
					timestamp: '2026-05-01T00:00:00.000Z',
					content: 'Unfocused user question',
				},
				{
					type: 'assistant-message',
					timestamp: '2026-05-01T00:00:01.000Z',
					content: 'Unfocused assistant answer',
				},
			],
		}),
	} as never);

	setSplitLayout({
		draggedPaneId: null,
		startPaneDrag() {},
		endDrag() {},
		swapPanes() {},
	} as never);
</script>

{#snippet focusedContent()}
	<div data-testid="focused-workspace">Focused workspace</div>
{/snippet}

<ChatPane
	paneId="pane-1"
	chatId="chat-1"
	{isFocused}
	draggedChatId={null}
	{onFocus}
	onClose={() => {}}
	onDelete={() => {}}
	onDrop={() => {}}
	{focusedContent}
/>
