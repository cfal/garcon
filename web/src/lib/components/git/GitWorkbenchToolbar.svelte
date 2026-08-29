<script lang="ts">
	import GitCommitHorizontal from '@lucide/svelte/icons/git-commit-horizontal';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Upload from '@lucide/svelte/icons/upload';
	import type { GitWorkbenchSurfaceController } from '$lib/git/workbench/git-workbench-surface.svelte.js';
	import type { ResponsiveSurfaceAction } from '$lib/components/shared/ResponsiveSurfaceActions.svelte';
	import { getGitReviewDisplay, getLocalSettings } from '$lib/context';
	import GitDiffSettingsMenuContent from './GitDiffSettingsMenuContent.svelte';
	import GitSurfaceToolbar from './GitSurfaceToolbar.svelte';
	import * as m from '$lib/paraglide/messages.js';
	import type { WorkspaceWindowId } from '$lib/workspace/surface-types.js';

	let {
		controller,
		presentation,
		onCommit,
		onPush,
		onRefresh,
	}: {
		controller: GitWorkbenchSurfaceController;
		presentation: WorkspaceWindowId | 'mobile';
		onCommit: () => void;
		onPush: () => void;
		onRefresh: () => void;
	} = $props();

	const reviewDisplay = getGitReviewDisplay();
	const localSettings = getLocalSettings();
	const canPush = $derived(
		Boolean(controller.repository.remoteStatus?.hasRemote) &&
			(!controller.repository.remoteStatus?.hasUpstream ||
				(controller.repository.remoteStatus?.ahead ?? 0) > 0),
	);
	const actions = $derived<ResponsiveSurfaceAction[]>([
		{
			id: 'commit',
			label: m.git_changes_commit(),
			icon: GitCommitHorizontal,
			onclick: onCommit,
			disabled: controller.workbench.commit.isCommitting,
			priority: 0,
			showLabel: presentation === 'mobile',
			variant: 'primary',
		},
		{
			id: 'push',
			label: m.git_header_push_to_remote(),
			icon: Upload,
			onclick: onPush,
			disabled: !canPush || controller.repository.isPushing,
			busy: controller.repository.isPushing,
			priority: 2,
		},
		{
			id: 'refresh',
			label: m.git_header_refresh(),
			icon: RefreshCw,
			onclick: onRefresh,
			disabled: controller.workbench.files.isLoadingTree,
			busy: controller.workbench.files.isLoadingTree,
			priority: 1,
		},
	]);
</script>

{#snippet diffSettings()}
	<GitDiffSettingsMenuContent
		diffMode={reviewDisplay.diffMode}
		contextLines={reviewDisplay.contextLines}
		diffFontSize={localSettings.gitDiffFontSize}
		onSetDiffMode={(mode) => reviewDisplay.setDiffMode(mode)}
		onSetContextLines={(lines) => reviewDisplay.setContextLines(lines)}
		onSetDiffFontSize={(size) => localSettings.set('gitDiffFontSize', size)}
	/>
{/snippet}

<GitSurfaceToolbar
	target={controller.target}
	{presentation}
	{actions}
	menuLeadingContent={diffSettings}
/>
