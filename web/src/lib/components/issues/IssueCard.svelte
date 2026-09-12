<script lang="ts">
	import type { IssueStatus, IssueSummary } from '$shared/issues';
	import GripVertical from '@lucide/svelte/icons/grip-vertical';
	import MessageSquare from '@lucide/svelte/icons/message-square';
	import Link2 from '@lucide/svelte/icons/link-2';
	import IssueStatusMenu from './IssueStatusMenu.svelte';
	import { issuePriorityLabel, isIssueProjectPath } from './issue-presentation.js';
	import { issueDraggable } from './issue-drag.js';
	import * as m from '$lib/paraglide/messages.js';
	let {
		issue,
		board = false,
		selected,
		showProject,
		pending = false,
		onOpen,
		onStatus,
	}: {
		issue: IssueSummary;
		board?: boolean;
		selected: boolean;
		showProject: boolean;
		pending?: boolean;
		onOpen: (issue: IssueSummary) => void;
		onStatus: (issue: IssueSummary, status: IssueStatus) => void;
	} = $props();
</script>

<article
	class:issue-card={board}
	class:issue-row={!board}
	class:issue-selected={selected}
	data-issue-id={issue.id}
	aria-busy={pending}
	use:issueDraggable={{ getIssue: () => issue, canDrag: () => !pending }}
>
	{#if board}<button
			type="button"
			class="issue-drag"
			data-issue-drag
			aria-label={m.issues_drag()}
			title={m.issues_drag()}
			tabindex="-1"><GripVertical size={14} /></button
		>{/if}
	<button
		type="button"
		class="issue-open"
		aria-label={m.issues_open_issue({ id: issue.id })}
		onclick={() => onOpen(issue)}
		data-issue-focus={JSON.stringify({ kind: 'issue', issueId: issue.id, control: 'open' })}
	>
		<span class="issue-id">{issue.id}</span><span class="issue-row-title">{issue.title}</span>
		{#if showProject}<span
				class="issue-project"
				data-path={isIssueProjectPath(issue.project)}
				title={issue.project}>{issue.project}</span
			>{/if}
	</button>
	<div class="issue-card-meta">
		<span class="issue-priority" data-priority={issue.priority}
			>{issuePriorityLabel(issue.priority)}</span
		>
		<IssueStatusMenu {issue} disabled={pending} onStatus={(status) => onStatus(issue, status)} />
		{#if issue.blockedByCount}<span class="issue-indicator" title={m.issues_blocked_by()}
				><Link2 size={12} />{issue.blockedByCount}</span
			>{/if}
		{#if issue.commentCount}<span class="issue-indicator" title={m.issues_comments()}
				><MessageSquare size={12} />{issue.commentCount}</span
			>{/if}
		<span
			class="issue-owner"
			title={issue.assignee?.kind === 'chat' ? issue.assignee.chatId : issue.assignee?.username}
			>{issue.assignee?.kind === 'chat'
				? m.issues_chat({ id: `…${issue.assignee.chatId.slice(-4)}` })
				: (issue.assignee?.username ?? m.issues_unassigned())}</span
		>
	</div>
</article>
