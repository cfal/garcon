<script lang="ts">
	import Folder from '@lucide/svelte/icons/folder';
	import Tag from '@lucide/svelte/icons/tag';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Check from '@lucide/svelte/icons/check';
	import { Popover, PopoverContent, PopoverTrigger } from '$lib/components/ui/popover';
	import type { IssuesController } from '$lib/issues/catalog/issues-controller.svelte.js';
	import { isIssueProjectPath } from './issue-presentation.js';
	import * as m from '$lib/paraglide/messages.js';
	let {
		controller,
		field,
		id,
		onSelect,
	}: {
		controller: IssuesController;
		field: 'project' | 'label';
		id?: string;
		onSelect: (value: string | undefined) => boolean;
	} = $props();
	let open = $state(false);
	let prefix = $state('');
	let values = $state.raw<readonly string[]>([]);
	let loading = $state(false);
	let failed = $state(false);
	let trigger = $state<HTMLElement | null>(null);
	const selected = $derived(controller.query[field]);
	const Icon = $derived(field === 'project' ? Folder : Tag);
	const messages = $derived.by(() => {
		if (field === 'project')
			return {
				label: m.issues_project(),
				all: m.issues_all_projects(),
				search: m.issues_project_search(),
				empty: m.issues_project_no_matches(),
				error: m.issues_project_load_error(),
			};
		return {
			label: m.issues_label_filter(),
			all: m.issues_any_label(),
			search: m.issues_label_search(),
			empty: m.issues_label_no_matches(),
			error: m.issues_label_load_error(),
		};
	});
	function select(value: string | undefined) {
		if (onSelect(value)) open = false;
	}
	$effect(() => {
		if (!open) return;
		const search = prefix;
		const facet = field;
		const partition = controller.bootstrap;
		const request = new AbortController();
		values = [];
		loading = true;
		failed = false;
		const timer = setTimeout(() => {
			void controller
				.facets(facet, search, request.signal)
				.then((result) => {
					if (!request.signal.aborted && controller.bootstrap === partition) {
						values = result.values;
						loading = false;
					}
				})
				.catch(() => {
					if (!request.signal.aborted) {
						failed = true;
						loading = false;
					}
				});
		}, 150);
		return () => {
			clearTimeout(timer);
			request.abort();
		};
	});
</script>

<div class="issue-facet-filter">
	<Popover
		bind:open
		onOpenChange={(next) => {
			if (next) prefix = '';
		}}
	>
		<PopoverTrigger
			{id}
			bind:ref={trigger}
			class="issue-facet-picker"
			disabled={!controller.bootstrap}
			aria-label={messages.label}
			title={selected ?? messages.all}
		>
			<Icon size={15} aria-hidden="true" />
			<span
				class="issue-project"
				data-path={field === 'project' && selected && isIssueProjectPath(selected)}
			>
				{selected ?? messages.all}
			</span>
			<ChevronDown size={14} aria-hidden="true" />
		</PopoverTrigger>
		<PopoverContent
			role="dialog"
			align="start"
			class="w-80 max-w-[calc(100vw-24px)] p-2"
			aria-label={messages.label}
			data-issue-dialog-owner={trigger?.closest<HTMLElement>('[data-issues-panel]')?.dataset
				.issuesPanel}
		>
			<button
				type="button"
				class="issue-facet-option"
				aria-pressed={!selected}
				onclick={() => select(undefined)}
			>
				<Icon size={15} aria-hidden="true" />
				<span>{messages.all}</span>
				{#if !selected}<Check size={15} aria-hidden="true" />{/if}
			</button>
			<input
				class="my-2 w-full rounded-lg border border-input bg-background px-3 py-2 text-base outline-none sm:pointer-fine:text-sm"
				aria-label={messages.search}
				placeholder={messages.search}
				bind:value={prefix}
			/>
			<div class="max-h-64 overflow-y-auto" aria-busy={loading}>
				{#each values as value (value)}
					<button
						type="button"
						class="issue-facet-option"
						aria-pressed={selected === value}
						title={value}
						onclick={() => select(value)}
					>
						<Icon size={15} aria-hidden="true" />
						<span class="issue-project" data-path={field === 'project' && isIssueProjectPath(value)}
							>{value}</span
						>
						{#if selected === value}<Check size={15} aria-hidden="true" />{/if}
					</button>
				{/each}
				{#if loading}<p class="p-2 text-sm text-muted-foreground" role="status">
						{m.issues_loading()}
					</p>
				{:else if failed}<p class="p-2 text-sm text-muted-foreground" role="alert">
						{messages.error}
					</p>
				{:else if !values.length}<p class="p-2 text-sm text-muted-foreground">
						{messages.empty}
					</p>{/if}
			</div>
		</PopoverContent>
	</Popover>
</div>
