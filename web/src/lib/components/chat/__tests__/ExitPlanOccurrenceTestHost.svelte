<script lang="ts">
	import { onDestroy } from 'svelte';
	import ConversationTranscriptItem from '../ConversationTranscriptItem.svelte';
	import { buildConversationFeedRenderModel } from '$lib/chat/transcript/conversation-feed-items.js';
	import {
		setAppShell,
		setChatSessions,
		setFileSessions,
		setLocalSettings,
	} from '$lib/context';
	import { FileSessionRegistry } from '$lib/files/sessions/file-session-registry.svelte.js';
	import { createAppShellStore } from '$lib/stores/app-shell.svelte.js';
	import { createChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte.js';
	import { createLocalSettingsStore } from '$lib/stores/local-settings.svelte.js';
	import { ExitPlanModeToolUseMessage } from '$shared/chat-types';
	import type { PendingPermissionRequest } from '$lib/types/chat';

	interface Props {
		pendingPermissionRequests: PendingPermissionRequest[];
		onExitPlanMode: (
			permissionOccurrenceId: string,
			choice: string,
			plan: string,
		) => void;
	}

	let { pendingPermissionRequests, onExitPlanMode }: Props = $props();

	const message = new ExitPlanModeToolUseMessage(
		'2026-08-15T00:00:00.000Z',
		'plan-1',
		'Historical plan.',
	);
	const renderModel = buildConversationFeedRenderModel([
		{ kind: 'message', id: 'view-1:1', ordinal: 1, message },
	]);
	const item = renderModel.items[0]!;

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

	setFileSessions(new FileSessionRegistry({
		getIsMobile: () => false,
		getDefaultPlacement: () => 'main',
		getEditorSettings: () => ({ wordWrap: false, showLineNumbers: true, fontSize: 12 }),
		getPlacement: () => ({
			async placeFileSession() {
				return 'cancelled';
			},
			async focusFileSession() {},
		}),
	}));

	const appShell = createAppShellStore();
	appShell.projectBasePath = '/workspace';
	setAppShell(appShell);

	const localSettings = createLocalSettingsStore();
	localSettings.autoExpandTools = false;
	setLocalSettings(localSettings);
	onDestroy(() => localSettings.destroy());
</script>

<ConversationTranscriptItem
	{item}
	{renderModel}
	agentId="claude"
	{pendingPermissionRequests}
	{onExitPlanMode}
/>
