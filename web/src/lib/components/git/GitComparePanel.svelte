<script lang="ts">
	import { untrack } from 'svelte';
	import type { GitCompareSurfaceController } from '$lib/git/review/git-compare-surface.svelte.js';
	import type { ChatDraftAppend } from '$lib/chat/composer/chat-draft-append.js';
	import { gitProjectInvalidations } from '$lib/git/surface/git-project-invalidation.svelte.js';
	import { resolveGitEditorRoot } from '$lib/git/surface/git-editor-root.js';
	import {
		getFileSessions,
		getLocalSettings,
		getTransientLayers,
		getWorkspaceCoordinator,
	} from '$lib/context';
	import { singletonSurfaceId } from '$lib/workspace/surface-types.js';
	import { startGitFreshnessPolling } from './git-freshness-polling';
	import GitCompareToolbar from './GitCompareToolbar.svelte';
	import GitComparisonDialog from './GitComparisonDialog.svelte';
	import GitComparisonScreen from './GitComparisonScreen.svelte';

	let {
		controller,
		presentation,
		visible = true,
		onAppendToChatDraft,
	}: {
		controller: GitCompareSurfaceController;
		presentation: 'main' | 'sidebar' | 'mobile';
		visible?: boolean;
		onAppendToChatDraft?: ChatDraftAppend;
	} = $props();

	const workspace = getWorkspaceCoordinator();
	const fileSessions = getFileSessions();
	const localSettings = getLocalSettings();
	const transientLayers = getTransientLayers();
	const comparison = $derived(controller.comparison);
	const presentationVisible = $derived(
		visible && controller.presentationVisible && !controller.target.projectIdentityPending,
	);
	const projectPath = $derived(controller.target.activeProjectPath);
	const activeTarget = $derived(controller.target.activeTarget ?? controller.target.fallbackTarget);
	const diffFontSize = $derived(Number.parseInt(localSettings.gitDiffFontSize, 10) || 12);
	const closeDisabled = $derived(
		workspace.isSurfaceCloseBlocked(singletonSurfaceId('git-compare')),
	);

	$effect(() => {
		if (!presentationVisible || !projectPath) return;
		return startGitFreshnessPolling({
			projectPath,
			checkFreshness: (path) => {
				untrack(() => void comparison.checkFreshness(path));
			},
		});
	});

	$effect(() => {
		if (!presentationVisible) return;
		const key = controller.target.effectiveProjectKey;
		if (!key) return;
		const version = gitProjectInvalidations.version(key);
		untrack(() => void controller.refreshForInvalidation(key, version));
	});

	function editComparison(): void {
		if (projectPath) void controller.target.branches.fetchRefs(projectPath);
		transientLayers.open('main-inert', () => comparison.editComparison());
	}

	function refreshComparison(): void {
		if (projectPath) void comparison.refresh(projectPath);
	}

	function openInEditor(relativePath: string, line: number): void {
		if (!projectPath) return;
		void fileSessions.open({
			fileRootPath: resolveGitEditorRoot({
				activeProjectPath: projectPath,
				targetRepoRoot: activeTarget?.repoRoot,
				reviewRepoRoot: comparison.snapshot?.repoRoot,
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
	<GitCompareToolbar
		{controller}
		{presentation}
		onEdit={editComparison}
		onRefresh={refreshComparison}
		onClose={() => void workspace.closeSurface(singletonSurfaceId('git-compare'))}
		{closeDisabled}
	/>

	<GitComparisonScreen
		{comparison}
		isLoading={controller.isLoading}
		{presentation}
		active={presentationVisible}
		fontSize={diffFontSize}
		onEdit={editComparison}
		onRefresh={refreshComparison}
		onOpenInEditor={openInEditor}
		{onAppendToChatDraft}
		onOpenChat={() => void workspace.focusChat()}
	/>

	{#if comparison.dialogOpen}
		<GitComparisonDialog
			{comparison}
			refs={controller.target.branches.refs}
			isLoadingRefs={controller.target.branches.isLoadingBranches}
			onSearchRefs={(query) => {
				if (projectPath) return controller.target.branches.fetchRefs(projectPath, query);
			}}
			onCompare={() => void controller.compareCurrentSpecification()}
			onClose={() => controller.closeComparisonDialog()}
		/>
	{/if}
</div>
