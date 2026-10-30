<script lang="ts">
	import GitPullRequest from '@lucide/svelte/icons/git-pull-request';
	import GitPullRequestDraft from '@lucide/svelte/icons/git-pull-request-draft';
	import GitPullRequestClosed from '@lucide/svelte/icons/git-pull-request-closed';
	import GitMerge from '@lucide/svelte/icons/git-merge';
	import type { PullRequestState } from '$lib/api/pull-requests';
	import { cn } from '$lib/utils/cn.js';
	import { prStateIconClass } from './pr-display.js';

	let {
		state: pullState,
		isDraft,
		class: className = '',
	}: { state: PullRequestState; isDraft: boolean; class?: string } = $props();

	const iconClass = $derived(cn('shrink-0', prStateIconClass(pullState, isDraft), className));
</script>

{#if isDraft}
	<GitPullRequestDraft class={iconClass} aria-hidden="true" />
{:else if pullState === 'merged'}
	<GitMerge class={iconClass} aria-hidden="true" />
{:else if pullState === 'closed'}
	<GitPullRequestClosed class={iconClass} aria-hidden="true" />
{:else}
	<GitPullRequest class={iconClass} aria-hidden="true" />
{/if}
