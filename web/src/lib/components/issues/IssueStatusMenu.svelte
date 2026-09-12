<script lang="ts">
	import { ISSUE_STATUSES, type IssueStatus, type IssueSummary } from '$shared/issues';
	import {
		DropdownMenu,
		DropdownMenuTrigger,
		DropdownMenuContent,
		DropdownMenuItem,
	} from '$lib/components/ui/dropdown-menu';
	import { issueStatusLabel } from './issue-presentation.js';
	import * as m from '$lib/paraglide/messages.js';
	let {
		issue,
		disabled = false,
		onStatus,
	}: {
		issue: Pick<IssueSummary, 'id' | 'status' | 'resolution'>;
		disabled?: boolean;
		onStatus: (status: IssueStatus) => void;
	} = $props();
	let trigger = $state<HTMLElement | null>(null);
</script>

<DropdownMenu>
	<DropdownMenuTrigger
		bind:ref={trigger}
		class="issue-status"
		data-status={issue.status}
		{disabled}
		data-issue-focus={JSON.stringify({ kind: 'issue', issueId: issue.id, control: 'status' })}
		aria-label={m.issues_status_for({ id: issue.id })}
	>
		<span class="issue-status-dot" aria-hidden="true"></span>{issue.status === 'closed'
			? issue.resolution === 'canceled'
				? m.issues_canceled()
				: m.issues_done()
			: issueStatusLabel(issue.status)}
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
					onSelect={() => onStatus(status)}
					>{issue.status === 'closed'
						? m.issues_reopen()
						: status === 'closed'
							? m.issues_close()
							: issueStatusLabel(status)}</DropdownMenuItem
				>{/if}
		{/each}
	</DropdownMenuContent>
</DropdownMenu>
