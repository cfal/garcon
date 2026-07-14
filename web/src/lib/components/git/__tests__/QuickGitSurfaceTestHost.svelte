<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import QuickGitSurface from '../QuickGitSurface.svelte';
	import { setGitBranchActions, setWorkspaceCoordinator } from '$lib/context';
	import { GitBranchSelectorState } from '$lib/stores/git/git-branch-selector-state.svelte';

	let props: ComponentProps<typeof QuickGitSurface> = $props();
	setGitBranchActions(new GitBranchSelectorState());
	setWorkspaceCoordinator({
		moveSurface: () => Promise.resolve(),
		closeSurface: () => Promise.resolve(true),
		isSurfaceCloseBlocked: () => false,
	} as never);
</script>

<QuickGitSurface {...props} />
