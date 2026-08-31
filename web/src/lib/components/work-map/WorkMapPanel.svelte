<script lang="ts">
	import ChevronsDownUp from '@lucide/svelte/icons/chevrons-down-up';
	import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
	import Search from '@lucide/svelte/icons/search';
	import Waypoints from '@lucide/svelte/icons/waypoints';
	import { untrack } from 'svelte';
	import * as m from '$lib/paraglide/messages.js';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import type { PresentationHostId } from '$lib/workspace/surface-types';
	import type { WorkMapController } from '$lib/work-map/work-map-controller.svelte';
	import { buildWorkMapModel } from '$lib/work-map/work-map-model';
	import WorkMapBranch from './WorkMapBranch.svelte';

	interface WorkMapPanelProps {
		controller: WorkMapController;
		chats: readonly ChatSessionRecord[];
		selectedChatId: string | null;
		visible: boolean;
		presentation: PresentationHostId;
	}

	let { controller, chats, selectedChatId, visible, presentation }: WorkMapPanelProps = $props();

	let currentTime = $state(new Date());
	const model = $derived.by(() => buildWorkMapModel(chats, controller.query));
	const titleId = $derived(`work-map-title-${presentation.replace(/[^a-zA-Z0-9_-]/g, '-')}`);

	$effect(() => {
		const validKeys = model.allNodeKeys;
		untrack(() => controller.reconcileNodeKeys(validKeys));
	});

	$effect(() => {
		if (!visible) return;
		currentTime = new Date();
		const interval = window.setInterval(() => {
			currentTime = new Date();
		}, 60_000);
		return () => window.clearInterval(interval);
	});
</script>

<section
	class="flex h-full min-h-0 min-w-0 flex-col bg-background text-foreground"
	aria-labelledby={titleId}
	data-work-map-panel
	data-presentation={presentation}
>
	<header class="shrink-0 border-b border-border bg-card px-3 py-3 sm:px-4">
		<div class="flex flex-wrap items-start justify-between gap-3">
			<div class="flex min-w-0 items-start gap-2.5">
				<div class="mt-0.5 rounded-md bg-accent p-1.5 text-accent-foreground">
					<Waypoints class="size-4" aria-hidden="true" />
				</div>
				<div class="min-w-0">
					<h1 id={titleId} class="text-base font-semibold">
						{m.workspace_surface_work_map()}
					</h1>
					<p class="text-xs text-muted-foreground">{m.work_map_description()}</p>
				</div>
			</div>

			<div class="flex items-center gap-1.5">
				<button
					type="button"
					aria-label={m.work_map_expand_all()}
					class="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
					disabled={model.collapsibleNodeKeys.length === 0}
					onclick={() => controller.expandAll()}
				>
					<ChevronsUpDown class="size-3.5" aria-hidden="true" />
					<span class="hidden sm:inline">{m.work_map_expand_all()}</span>
				</button>
				<button
					type="button"
					aria-label={m.work_map_collapse_all()}
					class="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
					disabled={model.collapsibleNodeKeys.length === 0}
					onclick={() => controller.collapseAll(model.collapsibleNodeKeys)}
				>
					<ChevronsDownUp class="size-3.5" aria-hidden="true" />
					<span class="hidden sm:inline">{m.work_map_collapse_all()}</span>
				</button>
			</div>
		</div>

		<div class="mt-3 flex flex-wrap items-center gap-2">
			<label class="relative min-w-52 flex-1 sm:max-w-md">
				<span class="sr-only">{m.work_map_search_label()}</span>
				<Search
					class="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
					aria-hidden="true"
				/>
				<input
					type="search"
					class="h-9 w-full rounded-md border border-input bg-background pl-8 pr-3 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 sm:pointer-fine:text-sm"
					placeholder={m.work_map_search_placeholder()}
					value={controller.query}
					oninput={(event) => controller.setQuery(event.currentTarget.value)}
				/>
			</label>

			<div class="flex flex-wrap gap-1.5 text-[11px] text-muted-foreground" aria-live="polite">
				<span class="rounded-full bg-muted px-2 py-1">
					{model.queryActive
						? m.work_map_result_count({ count: model.matchCount })
						: m.work_map_chat_count({ count: model.chatCount })}
				</span>
				<span class="rounded-full bg-muted px-2 py-1">
					{m.work_map_root_count({ count: model.rootCount })}
				</span>
				{#if model.missingParentCount > 0}
					<span
						class="rounded-full border border-status-warning-border bg-status-warning/10 px-2 py-1 text-status-warning-muted-foreground"
					>
						{m.work_map_missing_parent_count({ count: model.missingParentCount })}
					</span>
				{/if}
				{#if model.cycleChatCount > 0}
					<span
						class="rounded-full border border-status-warning-border bg-status-warning/10 px-2 py-1 text-status-warning-muted-foreground"
					>
						{m.work_map_cycle_count({ count: model.cycleChatCount })}
					</span>
				{/if}
			</div>
		</div>
	</header>

	<div class="min-h-0 flex-1 overflow-auto p-3 sm:p-4" data-work-map-scroll-region>
		{#if model.chatCount === 0}
			<div
				class="mx-auto flex h-full max-w-sm flex-col items-center justify-center px-4 text-center"
			>
				<Waypoints class="size-8 text-muted-foreground" aria-hidden="true" />
				<h2 class="mt-3 text-sm font-semibold">{m.work_map_empty_title()}</h2>
				<p class="mt-1 text-xs text-muted-foreground">{m.work_map_empty_description()}</p>
			</div>
		{:else if model.roots.length === 0}
			<div
				class="mx-auto flex h-full max-w-sm flex-col items-center justify-center px-4 text-center"
			>
				<Search class="size-8 text-muted-foreground" aria-hidden="true" />
				<h2 class="mt-3 text-sm font-semibold">{m.work_map_no_results_title()}</h2>
				<p class="mt-1 text-xs text-muted-foreground">{m.work_map_no_results_description()}</p>
			</div>
		{:else}
			<ul class="mx-auto max-w-4xl space-y-4" aria-label={m.workspace_surface_work_map()}>
				{#each model.roots as root (root.key)}
					<svelte:boundary>
						<WorkMapBranch
							node={root}
							{controller}
							{selectedChatId}
							{currentTime}
							searchActive={model.queryActive}
							root
						/>
						{#snippet failed()}
							<li
								class="rounded-md border border-status-error-border bg-status-error/10 px-3 py-2 text-xs text-status-error-foreground"
							>
								{m.work_map_node_render_failed()}
							</li>
						{/snippet}
					</svelte:boundary>
				{/each}
			</ul>
		{/if}
	</div>
</section>
