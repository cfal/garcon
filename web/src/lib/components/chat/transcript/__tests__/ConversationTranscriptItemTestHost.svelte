<script lang="ts">
	import { setExecutorsTestContext } from '$lib/executors/__tests__/executors-test-context';
	import { onDestroy } from 'svelte';
	import ConversationTranscriptItem from '../ConversationTranscriptItem.svelte';
	import { certifiedFeed } from './display-feed-fixtures.js';
	import { displayCertificate, displayOpen } from '$lib/chat/transcript/__tests__/display-fixtures.js';
	import { setAppShell, setChatSessions, setFileSessions, setLocalSettings, setNotifications } from '$lib/context';
	import { createNotificationsStore } from '$lib/stores/notifications.svelte.js';
	import type { ChatDisplayRow } from '$lib/chat/transcript/active-transcript-state.svelte.js';
	import type { PendingPermissionRequest } from '$lib/types/chat';
	import type { PermissionDecisionPayload } from '$shared/chat-command-contracts';
	import { FileSessionRegistry } from '$lib/files/sessions/file-session-registry.svelte.js';
	import { createAppShellStore } from '$lib/stores/app-shell.svelte.js';
	import { createChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte.js';
	import { createLocalSettingsStore } from '$lib/stores/local-settings.svelte.js';
	import { setCanonicalWorkspaceLayout } from '../../__tests__/workspace-layout-test-context.js';

	interface Props {
		rows: ChatDisplayRow[];
		pendingPermissionRequests?: PendingPermissionRequest[];
		onPermissionDecision?: (
			permissionOccurrenceId: string,
			decision: PermissionDecisionPayload,
		) => void;
	}

	let { rows, pendingPermissionRequests = [], onPermissionDecision }: Props = $props();
	const renderModel = $derived.by(() => {
		const canonical = rows.flatMap(row => row.kind === 'message' && row.ordinal !== undefined ? [{ ordinal: row.ordinal, message: row.message }] : []);
		const model = certifiedFeed(canonical, {
			certificate: displayCertificate(displayOpen('chat-1', 'generation-1', canonical.at(-1)?.ordinal ?? 0)),
		}).renderModel;
		for (const row of rows) {
			if (row.kind === 'message' && row.ordinal === undefined) model.items.push({ ...row, index: model.items.length });
		}
		return model;
	});
	setCanonicalWorkspaceLayout();
	setNotifications(createNotificationsStore());
	setExecutorsTestContext();

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
	setLocalSettings(localSettings);
	onDestroy(() => localSettings.destroy());
</script>

{#each renderModel.items as item (item.id)}
	<ConversationTranscriptItem
		{item}
		{renderModel}
		{pendingPermissionRequests}
		{onPermissionDecision}
	/>
{/each}
