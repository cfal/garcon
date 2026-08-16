<script lang="ts">
	import PermissionRequestRow from '../PermissionRequestRow.svelte';
	import { setAppShell, setChatSessions, setFileSessions } from '$lib/context';
	import { ConversationFeedItemState } from '../ConversationFeedItemState.svelte.js';
	import { buildConversationVirtualFeedModel } from '../conversation-feed-virtual-items.js';
	import type { PermissionDecisionPayload } from '$shared/chat-command-contracts';
	import {
		AskUserQuestionToolUseMessage,
		PermissionRequestMessage,
	} from '$shared/chat-types';
	import type { PendingPermissionRequest } from '$lib/types/chat';

	interface Props {
		onDecision: (
			permissionOccurrenceId: string,
			decision: PermissionDecisionPayload & { message?: string },
		) => void;
	}

	let { onDecision }: Props = $props();

	const timestamp = '2026-08-15T00:00:00.000Z';
	const itemState = new ConversationFeedItemState();
	const requests: PendingPermissionRequest[] = [
		permissionRequest('occurrence-one', 'First'),
		permissionRequest('occurrence-two', 'Second'),
	];
	const model = buildConversationVirtualFeedModel({
		showTopToolbarSpacer: false,
		showRefreshError: false,
		showEarlierBoundary: false,
		showLaterBoundary: false,
		reserveComposerTraySpace: false,
		transcriptViewId: 'view-1',
		surfaceIdentity: 'chat-1:view-1',
		transcriptItems: [],
		pendingPermissions: requests,
	});
	const permissionItems = model.items.filter((item) => item.kind === 'permission');

	setChatSessions({
		get selectedChat() {
			return { id: 'chat-1', projectPath: '/workspace/project' };
		},
	} as never);
	setFileSessions({
		open: async () => null,
	} as never);
	setAppShell({
		get projectBasePath() {
			return '/workspace';
		},
	} as never);

	function permissionRequest(permissionOccurrenceId: string, label: string): PendingPermissionRequest {
		return {
			chatId: 'chat-1',
			permissionOccurrenceId,
			requestedTool: new AskUserQuestionToolUseMessage(
				timestamp,
				`tool-${permissionOccurrenceId}`,
				undefined,
				[
					{
						id: `${label} mode?`,
						prompt: `${label} mode?`,
						header: label,
						options: [
							{
								id: `${label} fast`,
								label: `${label} fast`,
								description: `${label} fast path.`,
							},
							{
								id: `${label} careful`,
								label: `${label} careful`,
								description: `${label} careful path.`,
							},
						],
						allowMultiple: false,
					},
				],
			),
		};
	}

	function requestMessage(request: PendingPermissionRequest): PermissionRequestMessage {
		return new PermissionRequestMessage(
			timestamp,
			request.permissionOccurrenceId,
			request.requestedTool,
		);
	}
</script>

{#each permissionItems as item (item.key)}
	<section data-testid="permission-occurrence" data-virtual-key={item.key}>
		<PermissionRequestRow
			request={requestMessage(item.request)}
			{onDecision}
			draft={itemState.permissionDraft(item.request.permissionOccurrenceId)}
			onDraftChange={(draft) =>
				itemState.setPermissionDraft(
					item.request.permissionOccurrenceId,
					draft,
				)}
		/>
	</section>
{/each}
