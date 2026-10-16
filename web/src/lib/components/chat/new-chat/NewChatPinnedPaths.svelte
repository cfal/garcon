<script lang="ts">
	import { getExecutors, getRemoteSettings } from '$lib/context';
	import { NewChatPinnedPathsController } from '$lib/chat/new-chat/new-chat-pinned-paths-controller';
	import { executorStatus } from '$lib/executors/executors-store.svelte';
	import type { NewChatFormState } from '$lib/chat/new-chat/new-chat-form-state.svelte';
	import { filterExecutorPinnedPathGroups } from '$lib/project-paths/executor-pinned-paths';
	import Monitor from '@lucide/svelte/icons/monitor';
	import Pin from '@lucide/svelte/icons/pin';
	import Server from '@lucide/svelte/icons/server';
	import Search from '@lucide/svelte/icons/search';
	import X from '@lucide/svelte/icons/x';
	import * as m from '$lib/paraglide/messages.js';

	let { form }: { form: NewChatFormState } = $props();
	const id = $props.id();
	const executors = getExecutors();
	const pins = new NewChatPinnedPathsController(() => form, executors, getRemoteSettings());
	let showAll = $state(false);
	let searchQuery = $state('');
	let searchEngaged = $state(false);
	let searchInput = $state<HTMLInputElement | null>(null);
	const groups = $derived(pins.groups);
	const totalPaths = $derived(groups.reduce((count, group) => count + group.paths.length, 0));
	const scopedGroups = $derived(
		showAll ? groups : groups.filter((group) => group.executorId === form.executorId),
	);
	const scopedPathCount = $derived(
		scopedGroups.reduce((count, group) => count + group.paths.length, 0),
	);
	const searchAvailable = $derived(searchEngaged || scopedPathCount > 8 || searchQuery.length > 0);
	const filteredGroups = $derived(
		filterExecutorPinnedPathGroups(scopedGroups, executors.executors, searchQuery),
	);
	const hasOtherPins = $derived(groups.some((group) => group.executorId !== form.executorId));
	const scopeOptions = $derived([
		{
			label: m.chat_new_chat_pinned_paths_this_machine(),
			all: false,
			count: form.pinnedProjectPaths.length,
		},
		{
			label: m.chat_new_chat_pinned_paths_all_machines(),
			all: true,
			count: totalPaths,
		},
	]);
</script>

<section aria-label={m.chat_new_chat_pinned_paths()} class="min-w-0 space-y-2">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<span class="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
			<Pin class="size-3.5" aria-hidden="true" />
			{m.chat_new_chat_pinned_paths()}
		</span>
		{#if hasOtherPins || showAll}
			<div role="group" aria-label={m.chat_new_chat_pinned_paths()} class="inline-flex gap-0.5">
				{#each scopeOptions as scope (scope.label)}
					<button
						type="button"
						aria-label={scope.label}
						aria-pressed={showAll === scope.all}
						class="inline-flex min-h-7 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11 {showAll ===
						scope.all
							? 'bg-accent font-medium text-accent-foreground'
							: 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'}"
						onclick={() => {
							showAll = scope.all;
						}}
					>
						<span>{scope.label}</span><span
							class="text-[10px] tabular-nums text-muted-foreground"
							aria-hidden="true">{scope.count}</span
						></button
					>
				{/each}
			</div>
		{/if}
	</div>
	{#if searchAvailable}
		<div class="relative">
			<Search
				class="pointer-events-none absolute top-3 left-3 size-4 text-muted-foreground"
				aria-hidden="true"
			/>
			<input
				type="search"
				aria-label={m.chat_new_chat_pinned_paths_search()}
				placeholder={m.chat_new_chat_pinned_paths_search_placeholder()}
				bind:value={searchQuery}
				bind:this={searchInput}
				onfocus={() => {
					searchEngaged = true;
				}}
				class="h-11 w-full rounded-md border-0 bg-muted/40 pr-11 pl-9 text-base placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-fine:text-sm"
			/>
			{#if searchQuery}
				<button
					type="button"
					aria-label={m.chat_new_chat_pinned_paths_clear_search()}
					class="absolute top-0 right-0 flex size-11 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					onclick={() => {
						searchQuery = '';
						searchInput?.focus();
					}}
				>
					<X class="size-4" aria-hidden="true" />
				</button>
			{/if}
		</div>
	{/if}
	<div
		class="max-h-56 space-y-2 overflow-y-auto overscroll-contain p-1 sm:max-h-64 {searchAvailable
			? 'h-56 sm:h-64'
			: ''}"
	>
		{#each filteredGroups as group (group.executorId)}
			{@const executor = executors.get(group.executorId)}
			{@const ready = executors.isReady(group.executorId)}
			<div role="group" aria-label={executor?.label ?? group.executorId} class="space-y-1">
				<div
					class={showAll || !ready
						? 'sticky top-0 z-10 flex flex-wrap items-center gap-2 bg-(color:--dialog-surface) py-1 text-xs text-muted-foreground'
						: 'sr-only'}
				>
					{#if group.executorId === 'local'}
						<Monitor class="size-3.5 shrink-0" aria-hidden="true" />
					{:else}
						<Server class="size-3.5 shrink-0" aria-hidden="true" />
					{/if}
					<span class="min-w-0 flex-1 break-all font-semibold text-foreground"
						>{executor?.label ?? group.executorId}</span
					>
					<span class="text-[11px] tabular-nums"
						>{group.paths.length === 1
							? m.chat_new_chat_pinned_paths_count_singular({ count: group.paths.length })
							: m.chat_new_chat_pinned_paths_count_plural({ count: group.paths.length })}</span
					>
					<span id={`${id}-${group.executorId}-status`} class="text-[10px] font-medium"
						>{executor
							? executorStatus(executor)
							: m.chat_new_chat_pinned_paths_unavailable_executor()}</span
					>
				</div>
				<div class="flex flex-wrap gap-2">
					{#each group.paths as path (path)}
						{@const selected = form.executorId === group.executorId && form.projectPath === path}
						<button
							type="button"
							disabled={!ready || form.isUpdatingPinnedPath}
							aria-label={showAll ? `${executor?.label ?? group.executorId}: ${path}` : path}
							aria-describedby={`${id}-${group.executorId}-status`}
							aria-pressed={selected}
							title={path}
							class="min-h-7 min-w-0 max-w-full scroll-mt-10 rounded-md border px-2.5 py-1 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:min-h-11 {selected
								? 'border-border bg-accent text-accent-foreground'
								: 'border-border/70 bg-muted/40 text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground'}"
							onclick={() => pins.select(group.executorId, path)}
						>
							<span class="block max-w-[70vw] truncate sm:max-w-[24rem]">{path}</span>
						</button>
					{/each}
				</div>
			</div>
		{:else}
			<p role="status" class="p-2 text-xs text-muted-foreground">
				{searchQuery.trim()
					? m.chat_new_chat_pinned_paths_no_matches()
					: m.chat_new_chat_star_bookmark()}
			</p>
		{/each}
	</div>
</section>

<style>
	input::-webkit-search-cancel-button {
		appearance: none;
	}
</style>
