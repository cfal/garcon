<script lang="ts">
	import FileCode from '@lucide/svelte/icons/file-code';
	import Files from '@lucide/svelte/icons/files';
	import GitBranch from '@lucide/svelte/icons/git-branch';
	import GitCommitHorizontal from '@lucide/svelte/icons/git-commit-horizontal';
	import GitPullRequest from '@lucide/svelte/icons/git-pull-request';
	import MessageSquare from '@lucide/svelte/icons/message-square';
	import SquareTerminal from '@lucide/svelte/icons/square-terminal';
	import type { HostId, HostState } from '$lib/workspace/surface-types.js';
	import * as m from '$lib/paraglide/messages.js';

	let {
		host,
		hostState,
		labelFor,
		onSelect,
		onFocus,
	}: {
		host: HostId;
		hostState: HostState;
		labelFor: (surfaceId: string) => string;
		onSelect: (surfaceId: string) => void;
		onFocus?: (surfaceId: string) => void;
	} = $props();

	function handleKeydown(event: KeyboardEvent, index: number): void {
		const tabs = Array.from(
			event.currentTarget instanceof HTMLElement
				? (event.currentTarget
						.closest('[role="tablist"]')
						?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])
				: [],
		);
		if (tabs.length === 0) return;
		let nextIndex: number;
		switch (event.key) {
			case 'ArrowLeft':
				nextIndex = (index - 1 + tabs.length) % tabs.length;
				break;
			case 'ArrowRight':
				nextIndex = (index + 1) % tabs.length;
				break;
			case 'Home':
				nextIndex = 0;
				break;
			case 'End':
				nextIndex = tabs.length - 1;
				break;
			case 'Enter':
			case ' ':
				event.preventDefault();
				onSelect(hostState.order[index]);
				return;
			default:
				return;
		}
		event.preventDefault();
		tabs[nextIndex]?.focus();
	}

	function iconKind(surfaceId: string) {
		if (surfaceId === 'singleton:chat') return 'chat';
		if (surfaceId === 'singleton:git') return 'git';
		if (surfaceId === 'singleton:pull-requests') return 'pull-requests';
		if (surfaceId === 'singleton:files') return 'files';
		if (surfaceId === 'singleton:quick-git') return 'quick-git';
		if (surfaceId === 'terminal-launcher' || surfaceId.startsWith('terminal:')) return 'terminal';
		return 'file';
	}
</script>

{#snippet tab(surfaceId: string, index: number)}
	{@const kind = iconKind(surfaceId)}
	<button
		type="button"
		role="tab"
		id={`${host}-tab-${surfaceId}`}
		aria-controls={`${host}-panel-${surfaceId}`}
		aria-selected={hostState.activeId === surfaceId}
		tabindex={hostState.activeId === surfaceId ? 0 : -1}
		class={`flex h-8 max-w-40 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${
			hostState.activeId === surfaceId
				? 'border-chat-tabs-active-border bg-chat-tabs-active text-chat-tabs-active-foreground shadow-sm'
				: 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground'
		}`}
		title={labelFor(surfaceId)}
		onclick={() => onSelect(surfaceId)}
		onfocus={() => onFocus?.(surfaceId)}
		onpointerdown={() => onFocus?.(surfaceId)}
		onkeydown={(event) => handleKeydown(event, index)}
	>
		{#if kind === 'chat'}
			<MessageSquare class="h-3.5 w-3.5 shrink-0" />
		{:else if kind === 'git'}
			<GitBranch class="h-3.5 w-3.5 shrink-0" />
		{:else if kind === 'pull-requests'}
			<GitPullRequest class="h-3.5 w-3.5 shrink-0" />
		{:else if kind === 'files'}
			<Files class="h-3.5 w-3.5 shrink-0" />
		{:else if kind === 'quick-git'}
			<GitCommitHorizontal class="h-3.5 w-3.5 shrink-0" />
		{:else if kind === 'terminal'}
			<SquareTerminal class="h-3.5 w-3.5 shrink-0" />
		{:else}
			<FileCode class="h-3.5 w-3.5 shrink-0" />
		{/if}
		<span class="min-w-0 truncate">{labelFor(surfaceId)}</span>
	</button>
{/snippet}

<div
	class="relative flex min-w-0 items-center gap-0.5 rounded-lg border border-chat-tabs-rail-border bg-chat-tabs-rail p-0.5 text-foreground"
	role="tablist"
	aria-label={host === 'main' ? m.workspace_main_views() : m.workspace_sidebar_views()}
>
	{#if host === 'main' && hostState.order[0] === 'singleton:chat'}
		{@render tab(hostState.order[0], 0)}
	{/if}
	<div class="flex min-w-0 items-center gap-0.5 overflow-x-auto overscroll-x-contain">
		{#each hostState.order as surfaceId, index (surfaceId)}
			{#if host !== 'main' || index > 0}
				{@render tab(surfaceId, index)}
			{/if}
		{/each}
	</div>
</div>
