<script lang="ts">
	import LoadingStatus from './LoadingStatus.svelte';
	import ComposerStatusBar from './composer/ComposerStatusBar.svelte';
	import type { GitQuickSummaryReady } from '$lib/api/git.js';
	import type { LoadingStatus as ChatLoadingStatus } from '$lib/chat/conversation/conversation-lifecycle-state.svelte.js';
	import type { ComposerStatusBarBranchControls } from './composer/composer-status-bar-types.js';
	import type { ChatMaxWidth } from '$lib/stores/local-settings.svelte.js';
	import type { ComposerStatusBarPresentation } from '$lib/chat/composer/composer-status-bar.js';
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
		statusBar: ComposerStatusBarPresentation;
		projectPath: string;
		onProjectPath?: () => void;
		gitSummary: GitQuickSummaryReady | null;
		gitRefreshing: boolean;
		gitError: string | null;
		branchSelector: ComposerStatusBarBranchControls | null;
		isMobile: boolean;
		reduceMotion: boolean;
		onAbort: () => void;
		onCommit: () => void;
		announcementsEnabled?: boolean;
	}

	let {
		chatMaxWidth,
		isProcessing,
		status,
		agentId,
		spinnerSelectionKey,
		statusBar,
		projectPath,
		onProjectPath,
		gitSummary,
		gitRefreshing,
		gitError,
		branchSelector,
		isMobile,
		reduceMotion,
		onAbort,
		onCommit,
		announcementsEnabled = true,
	}: Props = $props();

	const shellClass = $derived(
		cn(CHAT_DOCK_SHELL_BASE_CLASS, CHAT_MAX_WIDTH_DOCK_SHELL_CLASS[chatMaxWidth]),
	);
	const frameClass = $derived(chatDockFrameClass(chatMaxWidth));
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
					showCommit={statusBar.commit}
					{gitSummary}
					{gitRefreshing}
					{gitError}
					{onCommit}
					{onAbort}
					{announcementsEnabled}
				/>
			{:else}
				<ComposerStatusBar
					{projectPath}
					{onProjectPath}
					items={statusBar}
					summary={gitSummary}
					isRefreshing={gitRefreshing}
					{isMobile}
					lastError={gitError}
					{branchSelector}
					{onCommit}
					{announcementsEnabled}
				/>
			{/if}
		</div>
	</div>
</div>
