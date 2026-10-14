<script lang="ts">
	import { getExecutors, getRemoteSettings } from '$lib/context';
	import { NewChatPinnedPathsController } from '$lib/chat/new-chat/new-chat-pinned-paths-controller';
	import { executorStatus } from '$lib/executors/executors-store.svelte';
	import type { NewChatFormState } from '$lib/chat/new-chat/new-chat-form-state.svelte';
	import ProjectPinnedPathList from '$lib/components/project-paths/ProjectPinnedPathList.svelte';
	import * as m from '$lib/paraglide/messages.js';

	let { form }: { form: NewChatFormState } = $props();
	const executors = getExecutors();
	const pins = new NewChatPinnedPathsController(() => form, executors, getRemoteSettings());
	let showAll = $state(false);
	const groups = $derived(pins.groups);
	const hasOtherPins = $derived(groups.some((group) => group.executorId !== form.executorId));
</script>

<section aria-label="Pinned paths" class="min-w-0 space-y-2">
	{#if hasOtherPins || showAll}
		<div class="flex flex-wrap items-center justify-between gap-2">
			<span class="text-xs font-medium text-muted-foreground">Pinned paths</span>
			<div
				role="group"
				aria-label="Pinned path scope"
				class="inline-flex rounded-md bg-muted/40 p-0.5"
			>
				{#each [{ label: 'This machine', all: false }, { label: 'All machines', all: true }] as scope (scope.label)}
					<button
						type="button"
						aria-pressed={showAll === scope.all}
						class="min-h-9 rounded px-2.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring {showAll ===
						scope.all
							? 'bg-background text-foreground shadow-sm'
							: 'text-muted-foreground hover:text-foreground'}"
						onclick={() => {
							showAll = scope.all;
						}}>{scope.label}</button
					>
				{/each}
			</div>
		</div>
	{/if}
	{#if showAll}
		<div
			class="max-h-56 space-y-3 overflow-y-auto overscroll-contain rounded-md border border-border p-2 sm:max-h-64"
		>
			{#each groups as group (group.executorId)}
				<svelte:boundary>
					{@const executor = executors.get(group.executorId)}
					{@const ready = executors.isReady(group.executorId)}
					<div class="space-y-1">
						<div class="flex flex-wrap items-center gap-x-2 px-1 text-xs text-muted-foreground">
							<span class="break-all font-medium text-foreground"
								>{executor?.label ?? group.executorId}</span
							>
							<span>{executor ? executorStatus(executor) : 'Unavailable executor'}</span>
						</div>
						<div class="grid gap-1 sm:grid-cols-2">
							{#each group.paths as path (path)}
								<button
									type="button"
									disabled={!ready || form.isUpdatingPinnedPath}
									aria-label={`${executor?.label ?? group.executorId}: ${path}`}
									aria-pressed={form.executorId === group.executorId && form.projectPath === path}
									class="block min-h-11 w-full rounded px-2 py-2 text-left text-xs break-all hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 {form.executorId ===
										group.executorId && form.projectPath === path
										? 'bg-accent text-accent-foreground'
										: 'text-muted-foreground'}"
									onclick={() => pins.select(group.executorId, path)}
									>{path}</button
								>
							{/each}
						</div>
					</div>
					{#snippet failed()}{/snippet}
				</svelte:boundary>
			{:else}
				<p class="text-xs text-muted-foreground">{m.chat_new_chat_star_bookmark()}</p>
			{/each}
		</div>
	{:else}
		<ProjectPinnedPathList
			pinnedProjectPaths={form.pinnedProjectPaths}
			selectedPath={form.projectPath}
			emptyLabel={m.chat_new_chat_star_bookmark()}
			disabled={form.isUpdatingPinnedPath || !form.executorReady}
			onSelect={(path) => pins.select(form.executorId, path)}
		/>
	{/if}
</section>
