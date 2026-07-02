<script lang="ts">
	import PermissionRequestRow from '../PermissionRequestRow.svelte';
	import { setAppShell, setChatSessions, setFileViewer } from '$lib/context';
	import type { PermissionDecisionPayload } from '$shared/chat-command-contracts';
	import type { PermissionRequestMessage } from '$shared/chat-types';
	import type { PermissionTerminalState } from '$lib/chat/conversation-feed-items';

	interface Props {
		request: PermissionRequestMessage;
		terminal?: PermissionTerminalState;
		onDecision: (
			permissionRequestId: string,
			decision: PermissionDecisionPayload & { message?: string },
		) => void;
	}

	let { request, terminal, onDecision }: Props = $props();

	setChatSessions({
		get selectedChat() {
			return { id: 'chat-1', projectPath: '/workspace/project' };
		},
	} as never);
	setFileViewer({
		openAuto: () => {},
	} as never);
	setAppShell({
		get projectBasePath() {
			return '/workspace';
		},
	} as never);
</script>

<PermissionRequestRow {request} {terminal} {onDecision} />
