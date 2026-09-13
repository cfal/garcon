<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import Plus from '@lucide/svelte/icons/plus';
	import Search from '@lucide/svelte/icons/search';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import ChevronUp from '@lucide/svelte/icons/chevron-up';
	import Check from '@lucide/svelte/icons/check';
	import X from '@lucide/svelte/icons/x';
	import type { IssuesController } from '$lib/issues/catalog/issues-controller.svelte.js';
	import type { IssueChatSummary } from './issue-presentation.js';
	import type { IssueListQuery, IssuePriority } from '$shared/issues';
	import { parseIssueAssigneeQuery } from '$shared/issue-validation';
	import IssueProjectFilter from './IssueProjectFilter.svelte';
	import IssueViewSettings from './IssueViewSettings.svelte';
	import IssueSearchOptions from './IssueSearchOptions.svelte';
	import * as m from '$lib/paraglide/messages.js';
	let {
		controller,
		chats,
		username,
		onCreate,
		onClose,
		closeDisabled = false,
	}: {
		controller: IssuesController;
		chats: readonly IssueChatSummary[];
		username: string;
		onCreate: () => void;
		onClose?: () => void;
		closeDisabled?: boolean;
	} = $props();
	let filterError = $state(false);
	let searchOpen = $state(false);
	let form = $state<HTMLFormElement | null>(null);
	let searchInput = $state<HTMLInputElement | null>(null);
	let searchText = $derived(controller.query.query ?? '');
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	const searchId = $props.id();
	const saveFeedback = $derived(controller.saveFeedback);
	const searchBusy = $derived(controller.loading || saveFeedback === 'saving');
	const hasFilters = $derived(
		Object.values(controller.query).some((value) => value !== false && value !== undefined),
	);
	function apply(extra: Pick<IssueListQuery, 'project' | 'ready' | 'includeClosed'> = {}) {
		clearTimeout(searchTimer);
		searchTimer = undefined;
		if (!form) return;
		const data = new FormData(form);
		const optionalText = (key: string) => String(data.get(key) ?? '').trim() || undefined;
		try {
			const priority = optionalText('priority');
			const assignee = optionalText('assignee');
			controller.setQuery({
				project: controller.query.project,
				query: optionalText('query'),
				status: optionalText('status') as IssueListQuery['status'],
				priority: priority === undefined ? undefined : (Number(priority) as IssuePriority),
				label: optionalText('label'),
				assignee: assignee === undefined ? undefined : parseIssueAssigneeQuery(assignee),
				ready: controller.query.ready,
				includeClosed: controller.query.includeClosed,
				...extra,
			});
			filterError = false;
		} catch {
			filterError = true;
		}
	}
	function scheduleSearch(event: Event) {
		if (event instanceof InputEvent && event.isComposing) return;
		const target = event.target;
		if (!(target instanceof HTMLInputElement) || !['query', 'label'].includes(target.name)) return;
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => apply(), 250);
	}
	async function toggleSearch() {
		searchOpen = !searchOpen;
		if (searchOpen) {
			await tick();
			searchInput?.focus();
		} else if (searchTimer !== undefined) apply();
	}
	function clearFilters() {
		clearTimeout(searchTimer);
		searchTimer = undefined;
		const hasInput = form && Array.from(new FormData(form).values()).some((value) => value !== '');
		if (hasFilters || hasInput) controller.setQuery({});
		searchText = '';
		filterError = false;
	}
	onDestroy(() => clearTimeout(searchTimer));
</script>

<header class="issues-toolbar">
	<form
		bind:this={form}
		class="issue-filter-form"
		oninput={scheduleSearch}
		onchange={() => apply()}
		onsubmit={(event) => {
			event.preventDefault();
			apply();
		}}
	>
		<div class="issue-toolbar-heading">
			<IssueProjectFilter {controller} onSelect={(project) => apply({ project })} />
			<button
				class="issue-button issue-icon-button"
				type="button"
				data-issue-search-button
				aria-busy={searchBusy}
				aria-expanded={searchOpen}
				aria-controls={searchId}
				aria-label={searchOpen ? m.issues_search_collapse() : m.issues_filter_apply()}
				title={searchOpen ? m.issues_search_collapse() : m.issues_filter_apply()}
				data-active={hasFilters}
				onclick={() => void toggleSearch()}
			>
				{#if searchBusy}<LoaderCircle size={16} class="animate-spin" />
				{:else if saveFeedback === 'saved'}<Check size={16} />
				{:else if searchOpen}<ChevronUp size={16} />
				{:else}<Search size={16} />{/if}
			</button>
			<button
				type="button"
				class="issue-button issue-primary issue-new-button"
				disabled={!controller.bootstrap}
				onclick={onCreate}
				data-issue-focus={JSON.stringify({ kind: 'toolbar', control: 'new' })}
			>
				<Plus size={15} />{m.issues_new()}
			</button>
			<IssueViewSettings {controller} />
			{#if onClose}<button
					type="button"
					class="issue-button issue-icon-button"
					aria-label={m.issues_close_view()}
					title={m.issues_close_view()}
					disabled={closeDisabled}
					onclick={onClose}><X size={16} /></button
				>{/if}
		</div>
		<div id={searchId} class="issue-search-options" hidden={!searchOpen}>
			<div class="issue-search-row">
				<label class="issue-field issue-search">
					<span class="sr-only">{m.issues_search()}</span>
					<input
						bind:this={searchInput}
						name="query"
						class="issue-input"
						placeholder={m.issues_search()}
						bind:value={searchText}
					/>
				</label>
				<button type="button" class="issue-button" onclick={clearFilters}
					>{m.issues_clear_filters()}</button
				>
			</div>
			<IssueSearchOptions {controller} {chats} {username} onFilter={apply} />
		</div>
		<span class="sr-only" role="status">
			{#if saveFeedback === 'saving'}{m.issues_saving()}
			{:else if saveFeedback === 'saved'}{m.issues_saved()}
			{:else if controller.loading}{m.issues_loading()}{/if}
		</span>
	</form>
	{#if filterError}<p class="issue-notice" role="alert">{m.issues_filter_error()}</p>{/if}
</header>
