<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import QuickGitSurface from '../QuickGitSurface.svelte';
	import { setGitBranchActions } from '$lib/context';
	import { GitBranchSelectorState } from '$lib/stores/git/git-branch-selector-state.svelte';

	let props: ComponentProps<typeof QuickGitSurface> = $props();
	setGitBranchActions(new GitBranchSelectorState());
</script>

<QuickGitSurface {...props} />
