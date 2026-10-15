<script lang="ts">
	import { getExecutors, getRemoteSettings } from '$lib/context';
	import { NewChatPinnedPathsController } from '$lib/chat/new-chat/new-chat-pinned-paths-controller';
	import { executorStatus } from '$lib/executors/executors-store.svelte';
	import type { NewChatFormState } from '$lib/chat/new-chat/new-chat-form-state.svelte';
	import { filterExecutorPinnedPathGroups } from '$lib/project-paths/executor-pinned-paths';
	import Check from '@lucide/svelte/icons/check';
	import Search from '@lucide/svelte/icons/search';
	import X from '@lucide/svelte/icons/x';
	import * as m from '$lib/paraglide/messages.js';

	let { form }: { form: NewChatFormState } = $props();
	const id = $props.id();
	const executors = getExecutors();
	const pins = new NewChatPinnedPathsController(() => form, executors, getRemoteSettings());
	let showAll = $state(false);
	let searchQuery = $state('');
	let searchInput = $state<HTMLInputElement | null>(null);
	const groups = $derived(pins.groups);
	const totalPaths = $derived(groups.reduce((count, group) => count + group.paths.length, 0));
	const scopedGroups = $derived(
		showAll ? groups : groups.filter((group) => group.executorId === form.executorId),
	);
	const scopedPathCount = $derived(
		scopedGroups.reduce((count, group) => count + group.paths.length, 0),
	);
	const searchAvailable = $derived(scopedPathCount > 8 || searchQuery.length > 0);
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
	{#if hasOtherPins || showAll}
		<div class="flex flex-wrap items-center justify-between gap-2">
			<span class="text-xs font-medium text-muted-foreground">{m.chat_new_chat_pinned_paths()}</span
			>
			<div
				role="group"
				aria-label={m.chat_new_chat_pinned_paths()}
				class="inline-flex rounded-md bg-muted/40 p-0.5"
			>
				{#each scopeOptions as scope (scope.label)}
					<button
						type="button"
						aria-label={scope.label}
						aria-pressed={showAll === scope.all}
						class="inline-flex min-h-11 items-center gap-1.5 rounded px-2.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring {showAll ===
						scope.all
							? 'bg-background text-foreground shadow-sm'
							: 'text-muted-foreground hover:text-foreground'}"
						onclick={() => {
							showAll = scope.all;
						}}
						>{scope.label}<span class="tabular-nums text-muted-foreground" aria-hidden="true"
							>{scope.count}</span
						></button
					>
				{/each}
			</div>
		</div>
	{/if}
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
				class="h-11 w-full rounded-md border border-border bg-background pr-11 pl-9 text-base placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-fine:text-sm"
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
		class="max-h-56 space-y-3 overflow-y-auto overscroll-contain sm:max-h-64 {showAll
			? 'rounded-md border border-border p-2'
			: ''} {searchAvailable ? 'h-56 sm:h-64' : ''}"
	>
		{#each filteredGroups as group (group.executorId)}
			{@const executor = executors.get(group.executorId)}
			{@const ready = executors.isReady(group.executorId)}
			<div role="group" aria-label={executor?.label ?? group.executorId} class="space-y-1">
				<div
					class={showAll || !ready
						? 'flex flex-wrap items-center gap-x-2 px-1 text-xs text-muted-foreground'
						: 'sr-only'}
				>
					<span class="break-all font-medium text-foreground"
						>{executor?.label ?? group.executorId}</span
					>
					<span class="tabular-nums"
						>{group.paths.length === 1
							? m.chat_new_chat_pinned_paths_count_singular({ count: group.paths.length })
							: m.chat_new_chat_pinned_paths_count_plural({ count: group.paths.length })}</span
					>
					<span id={`${id}-${group.executorId}-status`}
						>{executor
							? executorStatus(executor)
							: m.chat_new_chat_pinned_paths_unavailable_executor()}</span
					>
				</div>
				<div class="grid gap-1 sm:grid-cols-2">
					{#each group.paths as path (path)}
						{@const selected = form.executorId === group.executorId && form.projectPath === path}
						<button
							type="button"
							disabled={!ready || form.isUpdatingPinnedPath}
							aria-label={showAll ? `${executor?.label ?? group.executorId}: ${path}` : path}
							aria-describedby={`${id}-${group.executorId}-status`}
							aria-pressed={selected}
							class="flex min-h-11 w-full items-center gap-2 rounded border px-2 py-2 text-left text-xs break-all hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 {selected
								? 'border-border bg-accent text-accent-foreground'
								: 'border-border/70 bg-muted/40 text-muted-foreground'}"
							onclick={() => pins.select(group.executorId, path)}
							><span class="min-w-0 flex-1">{path}</span>{#if selected}<Check
									class="size-4 shrink-0"
									aria-hidden="true"
								/>{/if}</button
						>
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
