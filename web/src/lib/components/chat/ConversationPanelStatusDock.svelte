<script lang="ts">
	import LoadingStatus from './LoadingStatus.svelte';
	import GitQuickStatusTray from './GitQuickStatusTray.svelte';
	import type { GitQuickSummaryReady } from '$lib/api/git.js';
	import type { LoadingStatus as ChatLoadingStatus } from '$lib/chat/conversation/conversation-lifecycle-state.svelte.js';
	import type { GitQuickBranchSelectorControls } from './git-quick-status-tray-types.js';
	import type { ChatMaxWidth } from '$lib/stores/local-settings.svelte.js';
	import {
		CHAT_DOCK_SHELL_BASE_CLASS,
		CHAT_MAX_WIDTH_DOCK_FRAME_CLASS,
		CHAT_MAX_WIDTH_DOCK_SHELL_CLASS,
	} from '$lib/chat/conversation/chat-max-width.js';
	import { cn } from '$lib/utils/cn';

	interface Props {
		chatMaxWidth: ChatMaxWidth;
		isProcessing: boolean;
		status: ChatLoadingStatus | null;
		agentId: string;
		spinnerSelectionKey: string;
		quickCommitEnabled: boolean;
		quickCommitTrayVisible: boolean;
		quickCommitSummary: GitQuickSummaryReady | null;
		quickCommitRefreshing: boolean;
		quickCommitError: string | null;
		quickCommitBranchSelector: GitQuickBranchSelectorControls | null;
		isMobile: boolean;
		onAbort: () => void;
		onQuickCommit: () => void;
	}

	let {
		chatMaxWidth,
		isProcessing,
		status,
		agentId,
		spinnerSelectionKey,
		quickCommitEnabled,
		quickCommitTrayVisible,
		quickCommitSummary,
		quickCommitRefreshing,
		quickCommitError,
		quickCommitBranchSelector,
		isMobile,
		onAbort,
		onQuickCommit,
	}: Props = $props();

	const shellClass = $derived(
		cn(CHAT_DOCK_SHELL_BASE_CLASS, CHAT_MAX_WIDTH_DOCK_SHELL_CLASS[chatMaxWidth]),
	);
	const frameClass = $derived(
		cn('w-full', CHAT_MAX_WIDTH_DOCK_FRAME_CLASS[chatMaxWidth]),
	);
	const runningQuickCommitVisible = $derived(
		quickCommitEnabled && Boolean(quickCommitSummary && quickCommitSummary.changedFiles > 0),
	);
</script>

<div class={shellClass} data-conversation-panel-status-dock>
	<div class={frameClass}>
		<div class="relative h-0 shrink-0" data-conversation-panel-status-anchor>
			{#if isProcessing}
				<LoadingStatus
					isVisible={true}
					{status}
					{agentId}
					{spinnerSelectionKey}
					quickCommitVisible={runningQuickCommitVisible}
					quickCommitSummary={quickCommitSummary}
					onQuickCommit={onQuickCommit}
					onAbort={onAbort}
				/>
			{:else}
				<GitQuickStatusTray
					isVisible={quickCommitTrayVisible}
					summary={quickCommitSummary}
					isRefreshing={quickCommitRefreshing}
					{isMobile}
					lastError={quickCommitError}
					branchSelector={quickCommitBranchSelector}
					onCommit={onQuickCommit}
				/>
			{/if}
		</div>
	</div>
</div>
