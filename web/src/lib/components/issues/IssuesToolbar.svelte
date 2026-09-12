<script lang="ts">
	import Plus from '@lucide/svelte/icons/plus';
	import Search from '@lucide/svelte/icons/search';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Check from '@lucide/svelte/icons/check';
	import type { IssuesController } from '$lib/issues/catalog/issues-controller.svelte.js';
	import type { IssueChatSummary } from './issue-presentation.js';
	import { issuePriorityLabel, issueStatusLabel } from './issue-presentation.js';
	import {
		ISSUE_STATUSES,
		issueAssigneeQuery,
		type IssueListQuery,
		type IssuePriority,
	} from '$shared/issues';
	import { parseIssueAssigneeQuery } from '$shared/issue-validation';
	import IssueProjectInput from './IssueProjectInput.svelte';
	import IssueViewSettings from './IssueViewSettings.svelte';
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
	let filtersOpen = $state(false);
	const filtersId = $props.id();
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
	<form class="issue-filter-form" onsubmit={apply}>
		<div class="issue-toolbar-heading">
			<IssueProjectInput
				{controller}
				compact
				value={project ?? controller.query.project ?? ''}
				onChange={(value) => (project = value)}
				placeholder={m.issues_all_projects()}
			/>
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
		<div class="issue-search-row">
			<label class="issue-field issue-search"
				><span class="sr-only">{m.issues_search()}</span><input
					name="query"
					class="issue-input"
					placeholder={m.issues_search()}
					value={controller.query.query ?? ''}
				/></label
			>
			<button
				class="issue-button issue-icon-button"
				type="submit"
				data-issue-search-button
				aria-busy={controller.loading || controller.saveFeedback === 'saving'}
				aria-label={m.issues_filter_apply()}
				title={m.issues_filter_apply()}
			>
				{#if controller.loading || controller.saveFeedback === 'saving'}<LoaderCircle
						size={16}
						class="animate-spin"
					/>
				{:else if controller.saveFeedback === 'saved'}<Check size={16} />
				{:else}<Search size={16} />{/if}
			</button>
			<IssueViewSettings {controller} />
		</div>
		<div class="issue-filter-footer">
			<button
				type="button"
				class="issue-filter-toggle issue-muted"
				aria-expanded={filtersOpen}
				aria-controls={filtersId}
				onclick={() => (filtersOpen = !filtersOpen)}
			>
				<ChevronRight size={12} class={filtersOpen ? 'rotate-90' : ''} />{m.issues_filters()}
			</button>
			<div class="issue-filter-chip-scroll">
				{#if Object.values(controller.query).some((value) => value !== false && value !== undefined)}<div
						class="issue-filter-chips"
					>
						{#if controller.query.project}<span title={controller.query.project}
								>{controller.query.project}</span
							>{/if}
						{#if controller.query.query}<span>{controller.query.query}</span>{/if}
						{#if controller.query.status}<span>{issueStatusLabel(controller.query.status)}</span
							>{/if}
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
			</div>
			<span class="issue-save-feedback issue-muted" role="status">
				{#if controller.saveFeedback === 'saving'}{m.issues_saving()}
				{:else if controller.saveFeedback === 'saved'}{m.issues_saved()}{/if}
			</span>
		</div>
		<div id={filtersId} class="issue-filter-options" hidden={!filtersOpen}>
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
					value={controller.query.assignee ? issueAssigneeQuery(controller.query.assignee) : ''}
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
	</form>
	{#if filterError}<p class="issue-notice" role="alert">{m.issues_filter_error()}</p>{/if}
</header>
