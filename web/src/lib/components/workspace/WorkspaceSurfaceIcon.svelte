<script lang="ts">
	import FileCode from '@lucide/svelte/icons/file-code';
	import Files from '@lucide/svelte/icons/files';
	import GitBranch from '@lucide/svelte/icons/git-branch';
	import GitCommitHorizontal from '@lucide/svelte/icons/git-commit-horizontal';
	import GitCompareArrows from '@lucide/svelte/icons/git-compare-arrows';
	import GitPullRequest from '@lucide/svelte/icons/git-pull-request';
	import History from '@lucide/svelte/icons/history';
	import MessageSquare from '@lucide/svelte/icons/message-square';
	import SquareTerminal from '@lucide/svelte/icons/square-terminal';
	import type { ActiveSurfaceKind } from '$lib/workspace/surface-types.js';

	let {
		kind,
		class: className = 'h-3.5 w-3.5 shrink-0',
	}: { kind: ActiveSurfaceKind; class?: string } = $props();
</script>

{#if kind === 'chat'}<MessageSquare class={className} />
{:else if kind === 'git'}<GitBranch class={className} />
{:else if kind === 'git-history'}<History class={className} />
{:else if kind === 'git-compare'}<GitCompareArrows class={className} />
{:else if kind === 'pull-requests'}<GitPullRequest class={className} />
{:else if kind === 'files'}<Files class={className} />
{:else if kind === 'commit'}<GitCommitHorizontal class={className} />
{:else if kind === 'terminal' || kind === 'terminal-launcher'}<SquareTerminal class={className} />
{:else}<FileCode class={className} />{/if}
