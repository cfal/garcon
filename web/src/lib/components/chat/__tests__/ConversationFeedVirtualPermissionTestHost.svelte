<script lang="ts">
	import ConversationFeedVirtualItem from '../ConversationFeedVirtualItem.svelte';
	import { ConversationFeedItemState } from '../ConversationFeedItemState.svelte.js';
	import { createChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte.js';
	import { buildConversationFeedRenderModel } from '$lib/chat/transcript/conversation-feed-items.js';
	import { FileSessionRegistry } from '$lib/files/sessions/file-session-registry.svelte.js';
	import { createAppShellStore } from '$lib/stores/app-shell.svelte.js';
	import { setAppShell, setChatSessions, setFileSessions } from '$lib/context';
	import { ExitPlanModeToolUseMessage } from '$shared/chat-types';
	import type { PendingPermissionRequest } from '$lib/types/chat';
	import type { ConversationVirtualFeedItem } from '../conversation-feed-virtual-items.js';
	import { setCanonicalWorkspaceLayout } from './workspace-layout-test-context.js';

	const SOURCE_CHAT_ID = '1788592720180699';
	const TARGET_CHAT_ID = '1788592720180600';
	const TIMESTAMP = '2026-09-05T00:00:00.000Z';

	setCanonicalWorkspaceLayout();
	const sessions = createChatSessionsStore();
	for (const [chatId, title] of [
		[SOURCE_CHAT_ID, 'Source chat'],
		[TARGET_CHAT_ID, 'Target chat'],
	] as const) {
		sessions.createDraft({
			id: chatId,
			projectPath: '/workspace/project',
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
	sessions.setSelectedChatId(TARGET_CHAT_ID);
	setChatSessions(sessions);

	const appShell = createAppShellStore();
	appShell.projectBasePath = '/workspace';
	setAppShell(appShell);
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

	const request: PendingPermissionRequest = {
		chatId: SOURCE_CHAT_ID,
		permissionOccurrenceId: 'permission-chat-links',
		requestedTool: new ExitPlanModeToolUseMessage(
			TIMESTAMP,
			'tool-chat-links',
			`[Current](/chat/${SOURCE_CHAT_ID}) [Other](/chat/${TARGET_CHAT_ID})`,
		),
	};
	const item = {
		kind: 'permission',
		key: 'permission-chat-links',
		request,
		leadingSpacing: false,
		spacingAfter: 'none',
	} satisfies ConversationVirtualFeedItem;
</script>

<ConversationFeedVirtualItem
	{item}
	renderModel={buildConversationFeedRenderModel([])}
	showThinking={true}
	pendingPermissionRequests={[request]}
	chatContext={{ chatId: SOURCE_CHAT_ID, projectPath: '/workspace/project' }}
	earlierPageState={{ status: 'idle', error: null }}
	laterPageState={{ status: 'idle', error: null }}
	onLoadEarlier={() => {}}
	onLoadLater={() => {}}
	onPermissionDecision={() => {}}
	canForkAtMessageNow={true}
	itemState={new ConversationFeedItemState()}
	acquireTransientActivity={() => () => {}}
/>
