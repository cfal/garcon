<script lang="ts">
	import Filter from '@lucide/svelte/icons/list-filter';
	import { ISSUE_STATUSES, issueAssigneeQuery, type IssuePriority } from '$shared/issues';
	import type { IssuesController } from '$lib/issues/catalog/issues-controller.svelte.js';
	import {
		issuePriorityLabel,
		issueStatusLabel,
		type IssueChatSummary,
	} from './issue-presentation.js';
	import {
		DropdownMenu,
		DropdownMenuTrigger,
		DropdownMenuContent,
		DropdownMenuCheckboxItem,
	} from '$lib/components/ui/dropdown-menu';
	import IssueLabelFilter from './IssueLabelFilter.svelte';
	import * as m from '$lib/paraglide/messages.js';
	let {
		controller,
		chats,
		username,
		onFilter,
	}: {
		controller: IssuesController;
		chats: readonly IssueChatSummary[];
		username: string;
		onFilter: (change: { ready?: boolean; includeClosed?: boolean }) => void;
	} = $props();
</script>

<div class="issue-filter-options">
	<label class="issue-field">
		{m.issues_status()}
		<select class="issue-input" name="status" value={controller.query.status ?? ''}>
			<option value="">{m.issues_all_statuses()}</option>
			{#each ISSUE_STATUSES as status (status)}
				<option value={status}>{issueStatusLabel(status)}</option>
			{/each}
		</select>
	</label>
	<label class="issue-field">
		{m.issues_priority()}
		<select class="issue-input" name="priority" value={controller.query.priority ?? ''}>
			<option value="">{m.issues_all_priorities()}</option>
			{#each [0, 1, 2, 3] as priority (priority)}
				<option value={priority}>{issuePriorityLabel(priority as IssuePriority)}</option>
			{/each}
		</select>
	</label>
	<label class="issue-field">
		{m.issues_assignee()}
		<select
			class="issue-input"
			name="assignee"
			value={controller.query.assignee ? issueAssigneeQuery(controller.query.assignee) : ''}
		>
			<option value="">{m.issues_any_assignee()}</option>
			<option value="unassigned">{m.issues_unassigned()}</option>
			<option value={`user:${username}`}>{m.issues_me()}</option>
			{#each chats as chat (chat.id)}
				<option value={`chat:${chat.id}`}>{chat.title || chat.id}</option>
			{/each}
		</select>
	</label>
	<IssueLabelFilter {controller} />
	<DropdownMenu>
		<DropdownMenuTrigger
			class="issue-button issue-extra-filters"
			data-active={controller.query.ready || controller.query.includeClosed}
		>
			<Filter size={15} />{m.issues_filter_menu()}
		</DropdownMenuTrigger>
		<DropdownMenuContent align="end">
			<DropdownMenuCheckboxItem
				checked={controller.query.ready ?? false}
				onCheckedChange={(ready) => onFilter({ ready })}
			>
				{m.issues_ready()}
			</DropdownMenuCheckboxItem>
			<DropdownMenuCheckboxItem
				checked={controller.query.includeClosed ?? false}
				onCheckedChange={(includeClosed) => onFilter({ includeClosed })}
			>
				{m.issues_include_closed()}
			</DropdownMenuCheckboxItem>
		</DropdownMenuContent>
	</DropdownMenu>
</div>
