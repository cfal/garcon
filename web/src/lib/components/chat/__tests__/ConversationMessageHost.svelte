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
	import type { ConversationDisclosureStatePort } from '../ConversationFeedItemState.svelte.js';
	import { setCanonicalWorkspaceLayout } from './workspace-layout-test-context.js';

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
		alwaysExpandCliMessages?: boolean;
		disclosureState?: ConversationDisclosureStatePort;
		chatTitles?: Record<string, string>;
		chatTitleUpdate?: { chatId: string; title: string };
		selectedChatId?: string;
		removableChatId?: string;
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
		alwaysExpandCliMessages = false,
		disclosureState,
		chatTitles = {},
		chatTitleUpdate,
		selectedChatId = 'chat-1',
		removableChatId,
	}: Props = $props();
	setCanonicalWorkspaceLayout();
	const initialHost = untrack(() => ({
		projectBasePath,
		chatProjectPath,
		isMobile,
		alwaysExpandCliMessages,
		chatTitles,
		selectedChatId,
	}));

	const chatSessions = createChatSessionsStore();
	function createDraft(chatId: string, title: string): void {
		chatSessions.createDraft({
			id: chatId,
			projectPath: initialHost.chatProjectPath,
			startup: {
				agentId: 'claude',
				model: 'opus',
				permissionMode: 'default',
				thinkingMode: 'none',
				agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
				firstMessage: title,
			},
		});
	}
	createDraft(initialHost.selectedChatId, '');
	for (const [chatId, title] of Object.entries(initialHost.chatTitles)) {
		if (chatId === initialHost.selectedChatId) chatSessions.patchChat(chatId, { title });
		else createDraft(chatId, title);
	}
	chatSessions.setSelectedChatId(initialHost.selectedChatId);
	setChatSessions(chatSessions);

	const fileSessions = new FileSessionRegistry({
		getIsMobile: () => isMobile,
		getDefaultPlacement: () => ({ type: 'window', windowId: 'window-main' }),
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
	localSettings.alwaysExpandCliMessages = initialHost.alwaysExpandCliMessages;
	localSettings.showQuickCommitTray = true;
	setLocalSettings(localSettings);
	onDestroy(() => localSettings.destroy());

	let draftPreview = $state('');
</script>

<ConversationMessage
	{message}
	{rowId}
	{forkUpToSeq}
	{onForkChat}
	onAppendToDraft={(block) => (draftPreview += block)}
	{onGenerateTitleFromMessage}
	{canForkAtMessageNow}
	{disclosureState}
/>

<output data-testid="draft-preview">{draftPreview}</output>

{#if chatTitleUpdate}
	<button
		type="button"
		aria-label="Update chat title"
		onclick={() => chatSessions.patchChat(chatTitleUpdate.chatId, { title: chatTitleUpdate.title })}
	>
		Update chat title
	</button>
{/if}

{#if removableChatId}
	<button type="button" aria-label="Remove chat" onclick={() => chatSessions.removeChat(removableChatId)}>
		Remove chat
	</button>
{/if}
