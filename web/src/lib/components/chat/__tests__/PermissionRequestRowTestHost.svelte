<script lang="ts">
	import { setExecutorsTestContext } from '$lib/executors/__tests__/executors-test-context';
	import { untrack } from 'svelte';
	import type { ExecutorSnapshot } from '$shared/executors';
	import type { FileOpenRequest } from '$lib/files/sessions/file-session-registry.svelte';
	import PermissionRequestRow from '../PermissionRequestRow.svelte';
	import { setAppShell, setChatSessions, setFileSessions } from '$lib/context';
	import type { PermissionDecisionPayload } from '$shared/chat-command-contracts';
	import type { PermissionRequestMessage } from '$shared/chat-types';
	import type { PermissionTerminalState } from '$lib/chat/transcript/conversation-feed-items.js';
	import type { PermissionQuestionDraft } from '../ConversationFeedItemState.svelte.js';
	import type { ConversationMessageChatContext } from '$lib/chat/transcript/conversation-message-context.js';
	import { setCanonicalWorkspaceLayout } from './workspace-layout-test-context.js';

	interface Props {
		executors?: readonly ExecutorSnapshot[];
		onFileOpen?: (request: FileOpenRequest) => void;
		request: PermissionRequestMessage;
		terminal?: PermissionTerminalState;
		onDecision: (
			permissionOccurrenceId: string,
			decision: PermissionDecisionPayload & { message?: string },
		) => void;
		draft?: PermissionQuestionDraft;
		onDraftChange?: (draft: PermissionQuestionDraft) => void;
		chatContext?: ConversationMessageChatContext | null;
		chatTitles?: Record<string, string>;
	}

	let {
		executors,
		onFileOpen,
		request,
		terminal,
		onDecision,
		draft,
		onDraftChange,
		chatContext = null,
		chatTitles = {},
	}: Props = $props();
	setExecutorsTestContext(untrack(() => executors));
	setCanonicalWorkspaceLayout();

	setChatSessions({
		get selectedChat() {
			return { id: 'chat-1', projectPath: '/workspace/project' };
		},
		get byId() {
			return Object.fromEntries(
				Object.entries(chatTitles).map(([id, title]) => [id, { id, title }]),
			);
		},
	} as never);
	setFileSessions({
		open: async (input: FileOpenRequest) => {
			onFileOpen?.(input);
			return null;
		},
	} as never);
	setAppShell({
		get projectBasePath() {
			return '/workspace';
		},
	} as never);
</script>

<PermissionRequestRow {request} {terminal} {onDecision} {draft} {onDraftChange} {chatContext} />
