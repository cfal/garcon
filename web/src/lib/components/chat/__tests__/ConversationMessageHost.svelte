<script lang="ts">
	import ConversationMessage from '../ConversationMessage.svelte';
	import { setAppShell, setChatSessions, setFileSessions, setLocalSettings } from '$lib/context';
	import type { ChatMessage } from '$shared/chat-types';
	import {
		FileSessionRegistry,
		type FileOpenRequest,
	} from '$lib/files/sessions/file-session-registry.svelte.js';
	import { createAppShellStore } from '$lib/stores/app-shell.svelte.js';
	import { createChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte.js';
	import { createLocalSettingsStore } from '$lib/stores/local-settings.svelte.js';
	import { onDestroy, untrack } from 'svelte';

	type OpenAutoInput = FileOpenRequest;

	interface Props {
		message: ChatMessage;
		rowId?: string;
		openAuto?: (input: OpenAutoInput) => void;
		projectBasePath?: string;
		chatProjectPath?: string;
		isMobile?: boolean;
		forkUpToSeq?: number;
		openNewChatDialog?: (opts: { prefill: string }) => void;
		onForkChat?: (upToSeq?: number) => void;
		onGenerateTitleFromMessage?: (message: string, messageSeq?: number) => void | Promise<void>;
		canForkAtMessageNow?: boolean;
	}

	let {
		message,
		rowId,
		openAuto = () => {},
		projectBasePath = '/workspace',
		chatProjectPath = '/workspace/project',
		isMobile = false,
		forkUpToSeq,
		openNewChatDialog = () => {},
		onForkChat,
		onGenerateTitleFromMessage,
		canForkAtMessageNow = true,
	}: Props = $props();
	const initialHost = untrack(() => ({ projectBasePath, chatProjectPath, isMobile }));

	const chatSessions = createChatSessionsStore();
	chatSessions.createDraft({
		id: 'chat-1',
		projectPath: initialHost.chatProjectPath,
		startup: {
			agentId: 'claude',
			model: 'opus',
			permissionMode: 'default',
			thinkingMode: 'none',
			agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
			firstMessage: '',
		},
	});
	setChatSessions(chatSessions);

	const fileSessions = new FileSessionRegistry({
		getIsMobile: () => isMobile,
		getDefaultPlacement: () => 'main',
		getEditorSettings: () => ({ wordWrap: false, showLineNumbers: true, fontSize: 12 }),
		getPlacement: () => ({
			async placeFileSession() {
				return 'cancelled';
			},
			async focusFileSession() {},
		}),
	});
	fileSessions.open = async (input: OpenAutoInput) => {
		openAuto(input);
		return null;
	};
	setFileSessions(fileSessions);

	const appShell = createAppShellStore();
	appShell.projectBasePath = initialHost.projectBasePath;
	appShell.isMobile = initialHost.isMobile;
	appShell.openNewChatDialog = (seed) => openNewChatDialog({ prefill: seed?.prefill ?? '' });
	setAppShell(appShell);

	const localSettings = createLocalSettingsStore();
	localSettings.autoExpandTools = false;
	localSettings.showQuickCommitTray = true;
	setLocalSettings(localSettings);
	onDestroy(() => localSettings.destroy());
</script>

<ConversationMessage
	{message}
	{rowId}
	index={0}
	{forkUpToSeq}
	prevMessage={null}
	agentId="claude"
	{onForkChat}
	{onGenerateTitleFromMessage}
	{canForkAtMessageNow}
/>
