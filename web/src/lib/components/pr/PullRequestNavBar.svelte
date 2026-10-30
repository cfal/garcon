<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import Link from '@lucide/svelte/icons/link';
	import GitBranch from '@lucide/svelte/icons/git-branch';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import type { PullRequestSummary } from '$lib/api/pull-requests';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuItem,
		DropdownMenuSeparator,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import { copyToClipboard } from '$lib/utils/clipboard.js';

	// The compact bar of a narrow detail: the identity block scrolls under it, so it names the
	// pull request and holds the secondary actions that would otherwise crowd the header.
	interface PullRequestNavBarProps {
		pull: PullRequestSummary;
		repositoryName: string;
		onBack: () => void;
		onRefresh: () => void;
	}

	let { pull, repositoryName, onBack, onRefresh }: PullRequestNavBarProps = $props();

	const COPY_STATUS_MS = 2000;
	let copyStatus = $state('');
	let copyStatusTimer: ReturnType<typeof setTimeout> | null = null;
	const iconButtonClass =
		'flex shrink-0 items-center justify-center rounded-md p-1.5 text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none pointer-coarse:p-2';

	$effect(() => () => {
		if (copyStatusTimer) clearTimeout(copyStatusTimer);
	});

	async function copy(text: string, copiedMessage: string): Promise<void> {
		const copied = await copyToClipboard(text);
		copyStatus = copied ? copiedMessage : m.pull_request_copy_failed();
		if (copyStatusTimer) clearTimeout(copyStatusTimer);
		copyStatusTimer = setTimeout(() => (copyStatus = ''), COPY_STATUS_MS);
	}
</script>

<div
	class="flex h-12 shrink-0 items-center gap-1 border-b border-border bg-background px-2"
	data-pr-nav-bar
>
	<button
		type="button"
		class={iconButtonClass}
		onclick={onBack}
		aria-label={m.pull_requests_all()}
		title={m.pull_requests_all()}
		data-pr-back
	>
		<ArrowLeft class="h-5 w-5" />
	</button>
	<div class="flex min-w-0 flex-1 flex-col items-center leading-tight">
		<span class="text-sm font-semibold text-foreground tabular-nums">#{pull.number}</span>
		{#if copyStatus}
			<span class="max-w-full truncate text-[11px] text-muted-foreground" role="status"
				>{copyStatus}</span
			>
		{:else if repositoryName}
			<span class="max-w-full truncate text-[11px] text-muted-foreground">{repositoryName}</span>
		{/if}
	</div>
	<DropdownMenu>
		<DropdownMenuTrigger
			class={iconButtonClass}
			aria-label={m.pull_request_actions()}
			title={m.pull_request_actions()}
			data-pr-actions
		>
			<Ellipsis class="h-5 w-5" />
		</DropdownMenuTrigger>
		<DropdownMenuContent align="end">
			<DropdownMenuItem onSelect={() => window.open(pull.url, '_blank', 'noopener,noreferrer')}>
				<ExternalLink />
				{m.pull_request_open_on_github()}
			</DropdownMenuItem>
			<DropdownMenuItem onSelect={() => void copy(pull.url, m.pull_request_link_copied())}>
				<Link />
				{m.pull_request_copy_link()}
			</DropdownMenuItem>
			<DropdownMenuItem
				onSelect={() => void copy(pull.headRefName, m.pull_request_branch_copied())}
			>
				<GitBranch />
				{m.pull_request_copy_branch()}
			</DropdownMenuItem>
			<DropdownMenuSeparator />
			<DropdownMenuItem onSelect={onRefresh}>
				<RefreshCw />
				{m.common_refresh()}
			</DropdownMenuItem>
		</DropdownMenuContent>
	</DropdownMenu>
</div>
