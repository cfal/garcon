<script lang="ts">
	import ConversationMessage from '../ConversationMessage.svelte';
	import { setAppShell, setChatSessions, setFileSessions, setLocalSettings } from '$lib/context';
	import type { ChatMessage } from '$shared/chat-types';
	import type { FileOpenRequest } from '$lib/stores/file-sessions.svelte';

	type OpenAutoInput = FileOpenRequest;

	interface Props {
		message: ChatMessage;
		openAuto?: (input: OpenAutoInput) => void;
		projectBasePath?: string;
		chatProjectPath?: string;
			forkUpToSeq?: number;
			openNewChatDialog?: (opts: { prefill: string }) => void;
			onForkChat?: (upToSeq?: number) => void;
			onGenerateTitleFromMessage?: (message: string, messageSeq?: number) => void | Promise<void>;
			canForkAtMessageNow?: boolean;
		}

	let {
		message,
		openAuto = () => {},
		projectBasePath = '/workspace',
		chatProjectPath = '/workspace/project',
		forkUpToSeq,
			openNewChatDialog = () => {},
			onForkChat,
			onGenerateTitleFromMessage,
			canForkAtMessageNow = true,
		}: Props = $props();

	setChatSessions({
		get selectedChat() {
			return { id: 'chat-1', projectPath: chatProjectPath };
		},
	} as never);
	setFileSessions({
		open: async (input: OpenAutoInput) => {
			openAuto(input);
			return null;
		},
	} as never);
	setAppShell({
		get projectBasePath() {
			return projectBasePath;
		},
		openNewChatDialog: (opts: { prefill: string }) => openNewChatDialog(opts),
	} as never);
	setLocalSettings({
		autoExpandTools: false,
		showQuickCommitTray: true,
	} as never);
</script>

<ConversationMessage
	{message}
	index={0}
	{forkUpToSeq}
	prevMessage={null}
		agentId="claude"
		{onForkChat}
		{onGenerateTitleFromMessage}
		{canForkAtMessageNow}
	/>
