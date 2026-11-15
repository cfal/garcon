<script lang="ts">
	import { getExecutors, getRemoteSettings } from '$lib/context';
	import { tick, type Snippet } from 'svelte';
	import type { NewChatFormState } from '$lib/chat/new-chat/new-chat-form-state.svelte';
	import { NewChatProjectsController } from '$lib/chat/new-chat/new-chat-projects-controller';
	import { splitProjectPath } from '$lib/project-paths/compact-project-path';
	import { savePinnedProjectPathsOptimistically } from '$lib/project-paths/pinned-project-path-settings';
	import { removeProjectPathFromListOptimistically } from '$lib/project-paths/project-list-preferences';
	import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '$lib/components/ui/dropdown-menu';
	import { Popover, PopoverContent, PopoverTrigger } from '$lib/components/ui/popover';
	import { newChatProjectKey, splitNewChatProjects, type NewChatProject } from './new-chat-project-visibility';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import Pin from '@lucide/svelte/icons/pin';
	import PinOff from '@lucide/svelte/icons/pin-off';
	import ListMinus from '@lucide/svelte/icons/list-minus';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import Folder from '@lucide/svelte/icons/folder';
	import * as m from '$lib/paraglide/messages.js';

	let { form, actions }: { form: NewChatFormState; actions?: Snippet } = $props();
	const id = $props.id();
	const executors = getExecutors();
	const remoteSettings = getRemoteSettings();
	const projects = new NewChatProjectsController(() => form, executors, remoteSettings);
	const groups = $derived(projects.groups.filter(group => executors.isReady(group.executorId)));
	let promotedProject = $state<NewChatProject | undefined>();
	const partition = $derived(splitNewChatProjects(groups, promotedProject));
	let moreOpen = $state(false);
	let selectionClosedMore = false;
	let projectList = $state<HTMLElement | null>(null);
	let heading = $state<HTMLElement | null>(null);

	$effect(() => {
		if (partition.overflow.length === 0) moreOpen = false;
	});

	function selectProject(executorId: string, path: string): void {
		if (!projects.select(executorId, path) || !moreOpen) return;
		promotedProject = { executorId, path };
		selectionClosedMore = true;
		moreOpen = false;
	}

	function togglePin(executorId: string, path: string): void {
		void projects.togglePin(executorId, path, (paths, owner) =>
			savePinnedProjectPathsOptimistically(remoteSettings, paths, { executorId: owner }),
		);
	}

	async function removeFromList(executorId: string, path: string): Promise<void> {
		const removed = await projects.removeFromList(executorId, path, (owner, target) =>
			removeProjectPathFromListOptimistically(remoteSettings, target, { executorId: owner }),
		);
		if (!removed) return;
		await tick();
		if (document.activeElement !== document.body) return;
		const nextProject = projectList?.querySelector<HTMLButtonElement>(
			'[data-slot="new-chat-project-select"]:not(:disabled)',
		);
		(nextProject ?? heading)?.focus();
	}
</script>

{#snippet projectCards(rows: readonly NewChatProject[], region: 'primary' | 'more')}
	<div class="grid min-w-0 grid-cols-1 items-start gap-1.5">
		{#each rows as project (newChatProjectKey(project))}
			{@const path = project.path}
			{@const executor = executors.get(project.executorId)}
			{@const label = executor?.label ?? project.executorId}
			{@const selected = projects.isSelected(project.executorId, path)}
			{@const pinned = projects.isPinned(project.executorId, path)}
			{@const projectLabel = project.executorId === 'local' ? path : label + ': ' + path}
			<div
				data-slot="new-chat-project-card"
				class="flex min-w-0 items-stretch rounded-lg border transition-colors {selected
					? 'border-primary bg-accent text-accent-foreground'
					: 'border-border bg-card text-foreground hover:bg-accent/60'}"
			>
				<button
					data-slot="new-chat-project-select"
					type="button"
					aria-label={projectLabel}
					aria-pressed={selected}
					disabled={form.isUpdatingPinnedPath}
					onclick={() => selectProject(project.executorId, path)}
					title={path}
					class="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
				>
					<Folder class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
					<span class="min-w-0 flex-1">
						<span
							class="block truncate text-sm font-medium"
							title={splitProjectPath(path).name}>{splitProjectPath(path).name}</span
						>
						<span class="block truncate text-xs text-muted-foreground">
							{#if groups.length > 1 || project.executorId !== 'local'}{label}: {/if}{path}
						</span>
					</span>
					{#if pinned}
						<span data-slot="new-chat-project-pinned" role="img" aria-label={m.chat_new_chat_project_pinned()} title={m.chat_new_chat_project_pinned()} class="shrink-0 text-primary">
							<Pin class="size-3.5 rotate-45" aria-hidden="true" />
						</span>
					{/if}
				</button>
				{#if region === 'primary'}
					<DropdownMenu>
						<DropdownMenuTrigger
							disabled={form.isUpdatingPinnedPath}
							aria-label={m.chat_new_chat_project_actions({ project: projectLabel })}
							title={m.chat_new_chat_project_actions({ project: projectLabel })}
							aria-busy={projects.isPending(project.executorId, path)}
							class="inline-flex min-w-11 shrink-0 items-center justify-center rounded-r-lg hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
						>
							{#if projects.isPending(project.executorId, path)}<Loader2 class="size-4 animate-spin" aria-hidden="true" />{:else}<Ellipsis class="size-4" aria-hidden="true" />{/if}
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" class="w-44">
							<DropdownMenuItem disabled={form.isUpdatingPinnedPath} onSelect={() => togglePin(project.executorId, path)}>
								{#if pinned}<PinOff class="size-4" aria-hidden="true" />{m.chat_new_chat_project_unpin()}{:else}<Pin class="size-4" aria-hidden="true" />{m.chat_new_chat_project_pin()}{/if}
							</DropdownMenuItem>
							<DropdownMenuItem disabled={form.isUpdatingPinnedPath} onSelect={() => void removeFromList(project.executorId, path)}>
								<ListMinus class="size-4" aria-hidden="true" />{m.chat_new_chat_project_remove()}
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				{/if}
			</div>
		{/each}
	</div>
{/snippet}

<section bind:this={projectList} aria-labelledby={id + '-heading'} class="min-w-0 space-y-2">
	<div class="flex min-w-0 items-center justify-between gap-2">
		<h3 bind:this={heading} tabindex="-1" id={id + '-heading'} class="text-sm font-medium text-foreground">
			{m.chat_new_chat_saved_projects()}
		</h3>
		{@render actions?.()}
	</div>
	{#if groups.length > 0}
		<div data-slot="new-chat-project-list" class="space-y-3 p-1">
			{@render projectCards(partition.visible, 'primary')}
			{#if partition.overflow.length > 0}
				<Popover bind:open={moreOpen}>
					<PopoverTrigger
						data-slot="new-chat-projects-more"
						class="flex min-h-8 w-full items-center justify-between gap-2 rounded-md border border-border bg-card px-3 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
					>
						{m.chat_new_chat_more()}<ChevronDown class="size-3.5 shrink-0" aria-hidden="true" />
					</PopoverTrigger>
					<PopoverContent
						data-slot="new-chat-more-projects"
						aria-label={m.chat_new_chat_more_projects()}
						align="start"
						side="bottom"
						avoidCollisions={false}
						class="max-h-[min(20rem,var(--bits-popover-content-available-height))] w-[min(var(--bits-popover-anchor-width),calc(100vw-2rem))] overflow-y-auto overscroll-contain border-0 p-0"
						onEscapeKeydown={(event) => {
							event.preventDefault();
							event.stopPropagation();
							moreOpen = false;
						}}
						onCloseAutoFocus={(event) => {
							if (selectionClosedMore) event.preventDefault();
							selectionClosedMore = false;
						}}
					>
						{@render projectCards(partition.overflow, 'more')}
					</PopoverContent>
				</Popover>
			{/if}
		</div>
	{:else}
		<p
			data-slot="new-chat-pinned-paths-hint"
			class="rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground"
		>
			{m.chat_new_chat_star_bookmark()}
		</p>
	{/if}
</section>
