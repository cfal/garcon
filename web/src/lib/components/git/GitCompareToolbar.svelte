<script lang="ts">
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import type { GitCompareSurfaceController } from '$lib/git/review/git-compare-surface.svelte.js';
	import type { ResponsiveSurfaceAction } from '$lib/components/shared/ResponsiveSurfaceActions.svelte';
	import { getGitReviewDisplay, getLocalSettings } from '$lib/context';
	import GitDiffSettingsMenuContent from './GitDiffSettingsMenuContent.svelte';
	import GitSurfaceToolbar from './GitSurfaceToolbar.svelte';
	import * as m from '$lib/paraglide/messages.js';

	let {
		controller,
		presentation,
		onRefresh,
		onClose,
		closeDisabled,
	}: {
		controller: GitCompareSurfaceController;
		presentation: 'main' | 'sidebar' | 'mobile';
		onRefresh: () => void;
		onClose: () => void;
		closeDisabled: boolean;
	} = $props();

	const reviewDisplay = getGitReviewDisplay();
	const localSettings = getLocalSettings();
	const actions = $derived<ResponsiveSurfaceAction[]>([
		{
			id: 'refresh',
			label: m.git_header_refresh(),
			icon: RefreshCw,
			onclick: onRefresh,
			disabled: controller.isLoading,
			busy: controller.isLoading,
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
	{onClose}
	{closeDisabled}
	menuLeadingContent={diffSettings}
/>
