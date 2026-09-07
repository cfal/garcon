<script lang="ts">
	import LoadingStatus from './LoadingStatus.svelte';
	import GitQuickStatusTray from './GitQuickStatusTray.svelte';
	import type { GitQuickSummaryReady } from '$lib/api/git.js';
	import type { LoadingStatus as ChatLoadingStatus } from '$lib/chat/conversation/conversation-lifecycle-state.svelte.js';
	import type { GitQuickBranchSelectorControls } from './git-quick-status-tray-types.js';
	import type { ChatMaxWidth } from '$lib/stores/local-settings.svelte.js';
	import {
		CHAT_DOCK_SHELL_BASE_CLASS,
		CHAT_MAX_WIDTH_DOCK_SHELL_CLASS,
		chatDockFrameClass,
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
		reduceMotion: boolean;
		onAbort: () => void;
		onQuickCommit: () => void;
		announcementsEnabled?: boolean;
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
		reduceMotion,
		onAbort,
		onQuickCommit,
		announcementsEnabled = true,
	}: Props = $props();

	const shellClass = $derived(
		cn(CHAT_DOCK_SHELL_BASE_CLASS, CHAT_MAX_WIDTH_DOCK_SHELL_CLASS[chatMaxWidth]),
	);
	const frameClass = $derived(chatDockFrameClass(chatMaxWidth));
	const runningQuickCommitVisible = $derived(
		quickCommitEnabled && Boolean(quickCommitSummary && quickCommitSummary.changedFiles > 0),
	);
</script>

<div class={shellClass} data-conversation-panel-status-dock>
	<div class={frameClass}>
		<!-- The detached composer and panel dock establish matching processing variables separately. -->
		<div
			class={cn(
				'relative h-0 shrink-0',
				isProcessing && 'composer-thinking-active',
				isProcessing && reduceMotion && 'composer-reduce-motion',
			)}
			data-conversation-panel-status-anchor
		>
			{#if isProcessing}
				<LoadingStatus
					isVisible={true}
					{status}
					{agentId}
					{spinnerSelectionKey}
					quickCommitVisible={runningQuickCommitVisible}
					{quickCommitSummary}
					{onQuickCommit}
					{onAbort}
					{announcementsEnabled}
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
					{announcementsEnabled}
				/>
			{/if}
		</div>
	</div>
</div>
