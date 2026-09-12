<script lang="ts">
	import CircleDot from '@lucide/svelte/icons/circle-dot';
	import Plus from '@lucide/svelte/icons/plus';
	import Search from '@lucide/svelte/icons/search';
	import type { IssuesController } from '$lib/issues/catalog/issues-controller.svelte.js';
	import type { IssueChatSummary } from './issue-presentation.js';
	import { issuePriorityLabel, issueStatusLabel } from './issue-presentation.js';
	import { ISSUE_STATUSES, type IssueListQuery, type IssuePriority } from '$shared/issues';
	import { parseIssueAssigneeQuery } from '$shared/issue-validation';
	import IssueProjectInput from './IssueProjectInput.svelte';
	import * as m from '$lib/paraglide/messages.js';
	let {
		controller,
		chats,
		username,
		onCreate,
	}: {
		controller: IssuesController;
		chats: readonly IssueChatSummary[];
		username: string;
		onCreate: () => void;
	} = $props();
	let project = $state<string | null>(null);
	let filterError = $state(false);
	function apply(event: SubmitEvent) {
		event.preventDefault();
		const data = new FormData(event.currentTarget as HTMLFormElement);
		const text = (key: string) => String(data.get(key) ?? '').trim();
		try {
			controller.setQuery({
				...((project ?? controller.query.project)
					? { project: project ?? controller.query.project }
					: {}),
				...(text('query') ? { query: text('query') } : {}),
				...(text('status') ? { status: text('status') as IssueListQuery['status'] } : {}),
				...(text('priority') ? { priority: Number(text('priority')) as IssuePriority } : {}),
				...(text('label') ? { label: text('label') } : {}),
				...(text('assignee') ? { assignee: parseIssueAssigneeQuery(text('assignee')) } : {}),
				includeClosed: data.has('closed'),
				...(data.has('ready') ? { ready: true } : {}),
			});
			project = null;
			filterError = false;
		} catch {
			filterError = true;
		}
	}
</script>

<header class="issues-toolbar">
	<div class="issue-toolbar-heading">
		<h2><CircleDot size={19} />{m.issues_title()}</h2>
		<div class="issue-layout-switch" role="group" aria-label={m.issues_title()}>
			<button
				type="button"
				aria-pressed={controller.layout === 'list'}
				onclick={() => controller.setLayout('list')}>{m.issues_list()}</button
			>
			<button
				type="button"
				aria-pressed={controller.layout === 'board'}
				onclick={() => controller.setLayout('board')}>{m.issues_board()}</button
			>
		</div>
		<button
			type="button"
			class="issue-button issue-primary"
			disabled={!controller.bootstrap}
			onclick={onCreate}
			data-issue-focus={JSON.stringify({ kind: 'toolbar', control: 'new' })}
			><Plus size={15} />{m.issues_new()}</button
		>
	</div>
	<form class="issue-filter-form" onsubmit={apply}>
		<IssueProjectInput
			{controller}
			value={project ?? controller.query.project ?? ''}
			onChange={(value) => (project = value)}
			label={m.issues_project()}
			placeholder={m.issues_all_projects()}
		/>
		<label class="issue-field issue-search"
			><span class="sr-only">{m.issues_search()}</span><input
				name="query"
				class="issue-input"
				placeholder={m.issues_search()}
				value={controller.query.query ?? ''}
			/></label
		>
		<details class="issue-filter-details">
			<summary>{m.issues_filters()}</summary>
			<div class="issue-filter-options">
				<label class="issue-field"
					>{m.issues_status()}<select
						class="issue-input"
						name="status"
						value={controller.query.status ?? ''}
						><option value="">{m.issues_all_statuses()}</option
						>{#each ISSUE_STATUSES as status (status)}<option value={status}
								>{issueStatusLabel(status)}</option
							>{/each}</select
					></label
				>
				<label class="issue-field"
					>{m.issues_priority()}<select
						class="issue-input"
						name="priority"
						value={controller.query.priority ?? ''}
						><option value="">{m.issues_all_priorities()}</option
						>{#each [0, 1, 2, 3] as priority (priority)}<option value={priority}
								>{issuePriorityLabel(priority as IssuePriority)}</option
							>{/each}</select
					></label
				>
				<label class="issue-field"
					>{m.issues_assignee()}<select
						class="issue-input"
						name="assignee"
						value={controller.query.assignee === 'unassigned'
							? 'unassigned'
							: controller.query.assignee?.kind === 'chat'
								? `chat:${controller.query.assignee.chatId}`
								: controller.query.assignee
									? `user:${controller.query.assignee.username}`
									: ''}
					>
						<option value="">{m.issues_any_assignee()}</option><option value="unassigned"
							>{m.issues_unassigned()}</option
						><option value={`user:${username}`}>{m.issues_me()}</option>
						{#each chats as chat (chat.id)}<option value={`chat:${chat.id}`}
								>{chat.title || chat.id}</option
							>{/each}
					</select></label
				>
				<label class="issue-field"
					>{m.issues_label_filter()}<input
						class="issue-input"
						name="label"
						value={controller.query.label ?? ''}
					/></label
				>
				<label class="issue-check"
					><input
						name="ready"
						type="checkbox"
						checked={controller.query.ready}
					/>{m.issues_ready()}</label
				>
				<label class="issue-check"
					><input
						name="closed"
						type="checkbox"
						checked={controller.query.includeClosed}
					/>{m.issues_include_closed()}</label
				>
			</div>
		</details>
		<button
			class="issue-button"
			type="submit"
			aria-label={m.issues_filter_apply()}
			title={m.issues_filter_apply()}><Search size={16} /></button
		>
	</form>
	{#if filterError}<p class="issue-notice" role="alert">{m.issues_filter_error()}</p>{/if}
	{#if Object.values(controller.query).some((value) => value !== false && value !== undefined)}<div
			class="issue-filter-chips"
		>
			{#if controller.query.project}<span title={controller.query.project}
					>{controller.query.project}</span
				>{/if}
			{#if controller.query.query}<span>{controller.query.query}</span>{/if}
			{#if controller.query.status}<span>{issueStatusLabel(controller.query.status)}</span>{/if}
			{#if controller.query.priority !== undefined}<span
					>{issuePriorityLabel(controller.query.priority)}</span
				>{/if}
			{#if controller.query.label}<span>{controller.query.label}</span>{/if}
			{#if controller.query.assignee}<span
					>{controller.query.assignee === 'unassigned'
						? m.issues_unassigned()
						: controller.query.assignee.kind === 'chat'
							? controller.query.assignee.chatId
							: controller.query.assignee.username}</span
				>{/if}
			{#if controller.query.ready}<span>{m.issues_ready()}</span>{/if}
			{#if controller.query.includeClosed}<span>{m.issues_include_closed()}</span>{/if}
			<button
				type="button"
				class="issue-text-button"
				onclick={() => {
					controller.setQuery({});
					project = null;
				}}>{m.issues_clear_filters()}</button
			>
		</div>{/if}
</header>
