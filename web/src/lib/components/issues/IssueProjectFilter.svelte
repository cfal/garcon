<script lang="ts">
	import Folder from '@lucide/svelte/icons/folder';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Check from '@lucide/svelte/icons/check';
	import { Popover, PopoverContent, PopoverTrigger } from '$lib/components/ui/popover';
	import type { IssuesController } from '$lib/issues/catalog/issues-controller.svelte.js';
	import { isIssueProjectPath } from './issue-presentation.js';
	import * as m from '$lib/paraglide/messages.js';
	let {
		controller,
		onSelect,
	}: {
		controller: IssuesController;
		onSelect: (project: string | undefined) => boolean;
	} = $props();
	let open = $state(false);
	let prefix = $state('');
	let projects = $state.raw<readonly string[]>([]);
	let loading = $state(false);
	let failed = $state(false);
	let trigger = $state<HTMLElement | null>(null);
	const selected = $derived(controller.query.project);
	function select(project: string | undefined) {
		if (onSelect(project)) open = false;
	}
	$effect(() => {
		if (!open) return;
		const search = prefix;
		const partition = controller.bootstrap;
		const request = new AbortController();
		projects = [];
		loading = true;
		failed = false;
		const timer = setTimeout(() => {
			void controller
				.facets('project', search, request.signal)
				.then((result) => {
					if (!request.signal.aborted && controller.bootstrap === partition) {
						projects = result.values;
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

<div class="issue-project-field issue-project-filter">
	<Popover
		bind:open
		onOpenChange={(next) => {
			if (next) prefix = '';
		}}
	>
		<PopoverTrigger
			bind:ref={trigger}
			class="issue-project-picker"
			disabled={!controller.bootstrap}
			aria-label={m.issues_project()}
			title={selected ?? m.issues_all_projects()}
		>
			<Folder size={15} aria-hidden="true" />
			<span class="issue-project" data-path={selected && isIssueProjectPath(selected)}>
				{selected ?? m.issues_all_projects()}
			</span>
			<ChevronDown size={14} aria-hidden="true" />
		</PopoverTrigger>
		<PopoverContent
			role="dialog"
			align="start"
			class="w-80 max-w-[calc(100vw-24px)] p-2"
			aria-label={m.issues_project()}
			data-issue-dialog-owner={trigger?.closest<HTMLElement>('[data-issues-panel]')?.dataset
				.issuesPanel}
		>
			<button
				type="button"
				class="issue-project-option"
				aria-pressed={!selected}
				onclick={() => select(undefined)}
			>
				<Folder size={15} aria-hidden="true" />
				<span>{m.issues_all_projects()}</span>
				{#if !selected}<Check size={15} aria-hidden="true" />{/if}
			</button>
			<input
				class="my-2 w-full rounded-lg border border-input bg-background px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring sm:pointer-fine:text-sm"
				aria-label={m.issues_project_search()}
				placeholder={m.issues_project_search()}
				bind:value={prefix}
			/>
			<div class="max-h-64 overflow-y-auto" aria-busy={loading}>
				{#each projects as project (project)}
					<button
						type="button"
						class="issue-project-option"
						aria-pressed={selected === project}
						title={project}
						onclick={() => select(project)}
					>
						<Folder size={15} aria-hidden="true" />
						<span class="issue-project" data-path={isIssueProjectPath(project)}>{project}</span>
						{#if selected === project}<Check size={15} aria-hidden="true" />{/if}
					</button>
				{/each}
				{#if loading}<p class="p-2 text-sm text-muted-foreground" role="status">
						{m.issues_loading()}
					</p>
				{:else if failed}<p class="p-2 text-sm text-muted-foreground" role="alert">
						{m.issues_project_load_error()}
					</p>
				{:else if !projects.length}<p class="p-2 text-sm text-muted-foreground">
						{m.issues_project_no_matches()}
					</p>{/if}
			</div>
		</PopoverContent>
	</Popover>
</div>
