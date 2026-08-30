<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import ChatWindowPreview from '../ChatWindowPreview.svelte';
	import { setAppShell, setChatSessions, setFileSessions, setLocalSettings } from '$lib/context';
	import { ChatWindowPreviewStore } from '$lib/chat/transcript/chat-window-preview-store.svelte.js';
	import type { HideableToolType } from '$lib/stores/local-settings.svelte';
	import { createLocalSettingsStore } from '$lib/stores/local-settings.svelte';
	import { createAppShellStore } from '$lib/stores/app-shell.svelte.js';
	import { createChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte.js';
	import { FileSessionRegistry } from '$lib/files/sessions/file-session-registry.svelte.js';
	import { setCanonicalWorkspaceLayout } from './workspace-layout-test-context.js';

	let { hiddenToolTypes = [] }: { hiddenToolTypes?: HideableToolType[] } = $props();

	const previewStore = new ChatWindowPreviewStore();
	const chatSessions = createChatSessionsStore();
	chatSessions.createDraft({
		id: 'chat-1',
		projectPath: '/workspace/project',
		startup: {
			agentId: 'codex',
			model: 'default',
			permissionMode: 'default',
			thinkingMode: 'none',
			agentSettings: { ownerId: 'codex', schemaVersion: 1, values: {} },
			firstMessage: '',
		},
	});
	chatSessions.patchChat('chat-1', { title: 'Window Test Chat' });
	setChatSessions(chatSessions);

	setFileSessions(
		new FileSessionRegistry({
			getIsMobile: () => false,
			getDefaultPlacement: () => ({ type: 'window', windowId: 'window-main' }),
			getEditorSettings: () => ({ wordWrap: false, showLineNumbers: true, fontSize: 12 }),
			getPlacement: () => ({
				async placeFileSession() {
					return 'cancelled';
				},
				async focusFileSession() {},
			}),
		}),
	);
	const appShell = createAppShellStore();
	appShell.projectBasePath = '/workspace';
	setAppShell(appShell);
	const localSettings = createLocalSettingsStore();
	localSettings.autoExpandTools = false;
	localSettings.showThinking = true;
	localSettings.showQuickCommitTray = true;
	localSettings.chatMaxWidth = 'none';
	localSettings.hiddenToolTypes = untrack(() => hiddenToolTypes);
	setLocalSettings(localSettings);
	setCanonicalWorkspaceLayout();
	onDestroy(() => {
		localSettings.destroy();
	});
</script>

<ChatWindowPreview chatId="chat-1" {previewStore} />
