<script lang="ts">
	import { untrack } from 'svelte';
	import AlertTriangle from '@lucide/svelte/icons/triangle-alert';
	import X from '@lucide/svelte/icons/x';
	import type { GitHistorySurfaceController } from '$lib/git/history/git-history-surface.svelte.js';
	import type { ChatDraftAppend } from '$lib/chat/composer/chat-draft-append.js';
	import { gitProjectInvalidations } from '$lib/git/surface/git-project-invalidation.svelte.js';
	import { resolveGitEditorRoot } from '$lib/git/surface/git-editor-root.js';
	import {
		getFileSessions,
		getGitReviewDisplay,
		getLocalSettings,
		getTransientLayers,
		getWorkspaceCoordinator,
		getWorkspaceShortcuts,
	} from '$lib/context';
	import { singletonSurfaceId } from '$lib/workspace/surface-types.js';
	import GitHistoryToolbar from './GitHistoryToolbar.svelte';
	import GitHistoryView from './GitHistoryView.svelte';
	import GitRevertModal from './GitRevertModal.svelte';
	import * as m from '$lib/paraglide/messages.js';

	let {
		controller,
		presentation,
		visible = true,
		onAppendToChatDraft,
	}: {
		controller: GitHistorySurfaceController;
		presentation: 'main' | 'sidebar' | 'mobile';
		visible?: boolean;
		onAppendToChatDraft?: ChatDraftAppend;
	} = $props();

	const workspace = getWorkspaceCoordinator();
	const shortcuts = getWorkspaceShortcuts();
	const reviewDisplay = getGitReviewDisplay();
	const localSettings = getLocalSettings();
	const fileSessions = getFileSessions();
	const transientLayers = getTransientLayers();
	const presentationVisible = $derived(
		visible && controller.presentationVisible && !controller.target.projectIdentityPending,
	);
	const projectPath = $derived(controller.target.activeProjectPath);
	const activeTarget = $derived(controller.target.activeTarget ?? controller.target.fallbackTarget);
	const diffFontSize = $derived(Number.parseInt(localSettings.gitDiffFontSize, 10) || 12);
	const closeDisabled = $derived(
		workspace.isSurfaceCloseBlocked(singletonSurfaceId('git-history')),
	);

	$effect(() =>
		shortcuts.registerSurface(singletonSurfaceId('git-history'), (event) => {
			if (
				controller.history.screen !== 'list' ||
				!controller.comparisonSelection.active ||
				event.key !== 'Escape'
			) {
				return false;
			}
			event.preventDefault();
			controller.comparisonSelection.cancel();
			return true;
		}),
	);

	$effect(() => {
		if (!presentationVisible) return;
		const key = controller.target.effectiveProjectKey;
		if (!key) return;
		const version = gitProjectInvalidations.version(key);
		untrack(() => void controller.refreshForInvalidation(key, version));
	});

	function requestRevert(
		commit: NonNullable<GitHistorySurfaceController['pendingRevertCommit']>,
	): void {
		transientLayers.open('main-inert', () => {
			controller.pendingRevertCommit = commit;
		});
	}

	function refreshHistory(): void {
		if (controller.history.screen === 'comparison' && projectPath) {
			void controller.history.comparison.refresh(projectPath);
			return;
		}
		void controller.target.refreshTargets();
	}

	function openInEditor(relativePath: string, line: number): void {
		if (!projectPath) return;
		void fileSessions.open({
			fileRootPath: resolveGitEditorRoot({
				activeProjectPath: projectPath,
				targetRepoRoot: activeTarget?.repoRoot,
			}),
			relativePath,
			mode: 'code',
			origin: presentation,
			reason: 'user-open',
			line,
		});
	}
</script>

<div class="relative flex h-full min-h-0 flex-col bg-background">
	<GitHistoryToolbar
		{controller}
		{presentation}
		onRefresh={refreshHistory}
		onClose={() => void workspace.closeSurface(singletonSurfaceId('git-history'))}
		{closeDisabled}
	/>

	{#if controller.target.lastError || controller.lastError}
		<div
			class="flex items-center gap-2 border-b border-status-error-border bg-status-error/10 px-3 py-1.5 text-xs text-status-error-foreground"
		>
			<AlertTriangle class="h-3.5 w-3.5 shrink-0" />
			<span class="min-w-0 flex-1 truncate">
				{controller.target.lastError ?? controller.lastError}
			</span>
			<button
				type="button"
				class="rounded p-0.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
				aria-label={m.git_action_dismiss_error()}
				onclick={() => {
					controller.target.dismissError();
					controller.lastError = null;
				}}
			>
				<X class="h-3.5 w-3.5" />
			</button>
		</div>
	{/if}

	<GitHistoryView
		history={controller.history}
		comparisonSelection={controller.comparisonSelection}
		{projectPath}
		{presentation}
		active={presentationVisible}
		diffMode={reviewDisplay.diffMode}
		contextLines={reviewDisplay.contextLines}
		{diffFontSize}
		onRevertCommit={requestRevert}
		onOpenInEditor={openInEditor}
		onOpenSelectedComparison={() => controller.openSelectedComparison()}
		{onAppendToChatDraft}
		onOpenChat={() => void workspace.focusChat()}
		onSetDiffMode={(mode) => reviewDisplay.setDiffMode(mode)}
		onSetContextLines={(lines) => reviewDisplay.setContextLines(lines)}
		onSetDiffFontSize={(size) => localSettings.set('gitDiffFontSize', size)}
	/>

	{#if controller.pendingRevertCommit}
		<GitRevertModal
			commitShortHash={controller.pendingRevertCommit.shortHash}
			commitSubject={controller.pendingRevertCommit.subject}
			isReverting={controller.isRevertingCommit}
			onConfirm={() => void controller.revertPendingCommit()}
			onCancel={() => {
				if (!controller.isRevertingCommit) controller.pendingRevertCommit = null;
			}}
		/>
	{/if}
</div>
