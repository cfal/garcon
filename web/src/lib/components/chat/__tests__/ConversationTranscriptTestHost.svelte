<script lang="ts">
	import { onDestroy } from 'svelte';
	import ConversationTranscript from '../ConversationTranscript.svelte';
	import { setAppShell, setChatSessions, setFileSessions, setLocalSettings } from '$lib/context';
	import type { ChatDisplayRow } from '$lib/chat/transcript/active-transcript-state.svelte.js';
	import { FileSessionRegistry } from '$lib/files/sessions/file-session-registry.svelte.js';
	import { createAppShellStore } from '$lib/stores/app-shell.svelte.js';
	import { createChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte.js';
	import { createLocalSettingsStore } from '$lib/stores/local-settings.svelte.js';

	interface Props {
		rows: ChatDisplayRow[];
	}

	let { rows }: Props = $props();

	const chatSessions = createChatSessionsStore();
	chatSessions.createDraft({
		id: 'chat-1',
		projectPath: '/workspace/project',
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

	setFileSessions(
		new FileSessionRegistry({
			getIsMobile: () => false,
			getDefaultPlacement: () => 'main',
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
	setLocalSettings(localSettings);
	onDestroy(() => localSettings.destroy());
</script>

<ConversationTranscript {rows} agentId="claude" />
