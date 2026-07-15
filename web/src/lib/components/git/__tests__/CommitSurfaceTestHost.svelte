<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import CommitSurface from '../CommitSurface.svelte';
	import { setGitBranchActions, setWorkspaceCoordinator } from '$lib/context';
	import { GitBranchSelectorState } from '$lib/git/targets/git-branch-selector-state.svelte.js';

	let props: ComponentProps<typeof CommitSurface> = $props();
	setGitBranchActions(new GitBranchSelectorState());
	setWorkspaceCoordinator({
		moveSurface: () => Promise.resolve(),
		closeSurface: () => Promise.resolve(true),
		isSurfaceCloseBlocked: () => false,
	} as never);
</script>

<CommitSurface {...props} />
