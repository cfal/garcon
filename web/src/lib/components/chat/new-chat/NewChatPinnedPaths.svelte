<script lang="ts">
	import { getExecutors, getRemoteSettings } from '$lib/context';
	import { NewChatPinnedPathsController } from '$lib/chat/new-chat/new-chat-pinned-paths-controller';
	import { executorStatus } from '$lib/executors/executors-store.svelte';
	import type { NewChatFormState } from '$lib/chat/new-chat/new-chat-form-state.svelte';
	import { filterExecutorPinnedPathGroups } from '$lib/project-paths/executor-pinned-paths';
	import { pinnedProjectPathName } from '$lib/project-paths/project-pinned-paths';
	import Check from '@lucide/svelte/icons/check';
	import Folder from '@lucide/svelte/icons/folder';
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

<section aria-label={m.chat_new_chat_pinned_paths()} class="min-w-0 space-y-2.5">
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
						class="inline-flex min-h-11 items-center gap-2 rounded-md px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring {showAll ===
						scope.all
							? 'font-medium text-foreground'
							: 'text-muted-foreground hover:text-foreground'}"
						onclick={() => {
							showAll = scope.all;
						}}
					>
						<span class={showAll === scope.all ? 'underline decoration-2 underline-offset-8' : ''}
							>{scope.label}</span
						><span class="text-[10px] tabular-nums text-muted-foreground" aria-hidden="true"
							>{scope.count}</span
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
						? 'sticky top-0 z-10 flex flex-wrap items-center gap-2 bg-(color:--dialog-surface) px-2.5 py-0.5 text-xs text-muted-foreground'
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
				<div class="grid gap-1 sm:grid-cols-2">
					{#each group.paths as path (path)}
						{@const selected = form.executorId === group.executorId && form.projectPath === path}
						{@const name = pinnedProjectPathName(path)}
						<button
							type="button"
							disabled={!ready || form.isUpdatingPinnedPath}
							aria-label={showAll ? `${executor?.label ?? group.executorId}: ${path}` : path}
							aria-describedby={`${id}-${group.executorId}-status`}
							aria-pressed={selected}
							title={path}
							class="flex min-h-11 w-full scroll-mt-10 items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 {selected
								? 'bg-accent/60 text-accent-foreground'
								: 'text-foreground'}"
							onclick={() => pins.select(group.executorId, path)}
						>
							<Folder class="size-4 shrink-0 text-file-icon-folder" aria-hidden="true" />
							<span class="min-w-0 flex-1">
								<span class="block truncate text-sm font-medium leading-5">{name}</span>
								{#if name !== path}<span
										class="block text-[11px] leading-4 break-all text-muted-foreground">{path}</span
									>{/if}
							</span>{#if selected}<Check class="size-4 shrink-0" aria-hidden="true" />{/if}</button
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
