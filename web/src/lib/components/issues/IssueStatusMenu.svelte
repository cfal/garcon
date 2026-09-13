<script lang="ts">
	import { ISSUE_STATUSES, type IssueStatus, type IssueSummary } from '$shared/issues';
	import {
		DropdownMenu,
		DropdownMenuTrigger,
		DropdownMenuContent,
		DropdownMenuItem,
	} from '$lib/components/ui/dropdown-menu';
	import { issueStatusLabel } from './issue-presentation.js';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import * as m from '$lib/paraglide/messages.js';
	let {
		issue,
		disabled = false,
		variant = 'badge',
		onStatus,
	}: {
		issue: Pick<IssueSummary, 'id' | 'status' | 'resolution'>;
		disabled?: boolean;
		variant?: 'badge' | 'button';
		onStatus: (status: IssueStatus) => void;
	} = $props();
	let trigger = $state<HTMLElement | null>(null);
	const statusLabel = $derived.by(() => {
		if (issue.status !== 'closed') return issueStatusLabel(issue.status);
		return issue.resolution === 'canceled' ? m.issues_canceled() : m.issues_done();
	});
	function optionLabel(status: IssueStatus) {
		if (issue.status === 'closed') return m.issues_reopen();
		if (status === 'closed') return m.issues_close();
		return issueStatusLabel(status);
	}
</script>

<DropdownMenu>
	<DropdownMenuTrigger
		bind:ref={trigger}
		class={variant === 'button' ? 'issue-button issue-status-button' : 'issue-status'}
		data-status={issue.status}
		{disabled}
		data-issue-focus={JSON.stringify({ kind: 'issue', issueId: issue.id, control: 'status' })}
		aria-label={m.issues_status_for({ id: issue.id })}
	>
		<span class="issue-status-dot" aria-hidden="true"></span>{statusLabel}
		{#if variant === 'button'}<ChevronDown size={14} aria-hidden="true" />{/if}
	</DropdownMenuTrigger>
	<DropdownMenuContent
		align="end"
		data-issue-dialog-owner={trigger?.closest<HTMLElement>('[data-issues-panel]')?.dataset
			.issuesPanel}
		data-issue-focus={JSON.stringify({ kind: 'issue', issueId: issue.id, control: 'status' })}
	>
		{#each ISSUE_STATUSES as status (status)}
			{#if issue.status !== 'closed' || status === 'open'}<DropdownMenuItem
					disabled={issue.status === status}
					onSelect={() => onStatus(status)}>{optionLabel(status)}</DropdownMenuItem
				>{/if}
		{/each}
	</DropdownMenuContent>
</DropdownMenu>
