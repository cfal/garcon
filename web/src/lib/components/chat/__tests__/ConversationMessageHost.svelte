<script lang="ts">
	import ConversationMessage from '../ConversationMessage.svelte';
	import { setAppShell, setChatSessions, setFileViewer, setLocalSettings } from '$lib/context';
	import type { ChatMessage } from '$shared/chat-types';

	interface Props {
		message: ChatMessage;
	}

	let { message }: Props = $props();

	setChatSessions({
		selectedChat: { id: 'chat-1', projectPath: '/workspace/project' },
	} as never);
	setFileViewer({
		openAuto: () => {},
	} as never);
	setAppShell({
		projectBasePath: '/workspace',
		openNewChatDialog: () => {},
	} as never);
	setLocalSettings({
		autoExpandTools: false,
	} as never);
</script>

<ConversationMessage
	{message}
	index={0}
	prevMessage={null}
	agentId="claude"
/>
