<script lang="ts">
	import ConversationMessage from '../ConversationMessage.svelte';
	import { setAppShell, setChatSessions, setFileViewer, setLocalSettings } from '$lib/context';
	import type { ChatMessage } from '$shared/chat-types';
	import type { FileViewerRequest } from '$lib/stores/file-viewer.svelte';

	type OpenAutoInput = Omit<FileViewerRequest, 'preferredMode' | 'requestedAt'>;

	interface Props {
		message: ChatMessage;
		openAuto?: (input: OpenAutoInput) => void;
		projectBasePath?: string;
		chatProjectPath?: string;
	}

	let {
		message,
		openAuto = () => {},
		projectBasePath = '/workspace',
		chatProjectPath = '/workspace/project',
	}: Props = $props();

	setChatSessions({
		get selectedChat() {
			return { id: 'chat-1', projectPath: chatProjectPath };
		},
	} as never);
	setFileViewer({
		openAuto: (input: OpenAutoInput) => openAuto(input),
	} as never);
	setAppShell({
		get projectBasePath() {
			return projectBasePath;
		},
		openNewChatDialog: () => {},
	} as never);
	setLocalSettings({
		autoExpandTools: false,
	} as never);
</script>

<ConversationMessage {message} index={0} prevMessage={null} agentId="claude" />
