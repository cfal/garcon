<script lang="ts">
	import { getExecutors, getRemoteSettings } from '$lib/context';
	import type { NewChatFormState } from '$lib/chat/new-chat/new-chat-form-state.svelte';
	import { executorStatus } from '$lib/executors/executors-store.svelte';
	import { NewChatProjectsController } from '$lib/chat/new-chat/new-chat-projects-controller';
	import { splitProjectPath } from '$lib/project-paths/compact-project-path';
	import Folder from '@lucide/svelte/icons/folder';
	import Check from '@lucide/svelte/icons/check';
	import Pin from '@lucide/svelte/icons/pin';
	import * as m from '$lib/paraglide/messages.js';

	let { form }: { form: NewChatFormState } = $props();
	const id = $props.id();
	const executors = getExecutors();
	const projects = new NewChatProjectsController(() => form, executors, getRemoteSettings());
	const groups = $derived(projects.groups);
</script>

<section aria-labelledby={id + '-heading'} class="mb-5 min-w-0 space-y-3">
	<h3 id={id + '-heading'} class="text-sm font-medium text-foreground">
		{m.chat_new_chat_saved_projects()}
	</h3>
	{#if groups.length > 0}
		<div class="max-h-[min(24rem,40dvh)] space-y-4 overflow-y-auto overscroll-contain p-1">
			{#each groups as group (group.executorId)}
				{@const executor = executors.get(group.executorId)}
				{@const label = executor?.label ?? group.executorId}
				{@const ready = executors.isReady(group.executorId)}
				<div role="group" aria-label={label} class="min-w-0 space-y-2">
					{#if groups.length > 1 || group.executorId !== 'local' || !ready}
						<p class="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
							<span class="min-w-0 break-all font-medium">{label}</span>
							{#if !ready}
								<span id={id + '-' + group.executorId + '-status'}
									>{executor
										? executorStatus(executor)
										: m.chat_new_chat_pinned_paths_unavailable_executor()}</span
								>
							{/if}
						</p>
					{/if}
					<div class="grid min-w-0 items-start gap-2 sm:grid-cols-2">
						{#each group.paths as path (path)}
							{@const selected = projects.isSelected(group.executorId, path)}
							<button
								type="button"
								aria-label={group.executorId === 'local' ? path : label + ': ' + path}
								aria-pressed={selected}
								aria-describedby={!ready ? id + '-' + group.executorId + '-status' : undefined}
								disabled={!ready || form.isUpdatingPinnedPath}
								onclick={() => projects.select(group.executorId, path)}
								class="flex min-h-16 min-w-0 items-start gap-3 rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 {selected
									? 'border-primary bg-accent text-accent-foreground'
									: 'border-border bg-card text-foreground hover:bg-accent/60'}"
							>
								{#if projects.isPinned(group.executorId, path)}
									<Pin class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
								{:else}
									<Folder class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
								{/if}
								<span class="min-w-0 flex-1 space-y-1">
									<span
										class="block truncate text-sm font-medium"
										title={splitProjectPath(path).name}>{splitProjectPath(path).name}</span
									>
									<span class="block break-all text-xs text-muted-foreground">{path}</span>
								</span>
								{#if selected}<Check
										class="mt-0.5 size-4 shrink-0 text-primary"
										aria-hidden="true"
									/>{/if}
							</button>
						{/each}
					</div>
				</div>
			{/each}
		</div>
	{:else}
		<p
			data-slot="new-chat-pinned-paths-hint"
			class="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground"
		>
			{m.chat_new_chat_star_bookmark()}
		</p>
	{/if}
</section>
