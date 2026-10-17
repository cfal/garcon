<script lang="ts">
	import { getExecutors, getRemoteSettings } from '$lib/context';
	import type { NewChatFormState } from '$lib/chat/new-chat/new-chat-form-state.svelte';
	import { executorStatus } from '$lib/executors/executors-store.svelte';
	import { NewChatPinnedPathsController } from '$lib/chat/new-chat/new-chat-pinned-paths-controller';
	import ProjectPinnedPathList from '$lib/components/project-paths/ProjectPinnedPathList.svelte';
	import * as m from '$lib/paraglide/messages.js';

	let { form }: { form: NewChatFormState } = $props();
	const id = $props.id();
	const executors = getExecutors();
	const pins = new NewChatPinnedPathsController(() => form, executors, getRemoteSettings());
	let showAll = $state(false);
	const groups = $derived(pins.groups);
	const hasOtherPins = $derived(groups.some((group) => group.executorId !== form.executorId));
	const visibleGroups = $derived(
		showAll ? groups : groups.filter((group) => group.executorId === form.executorId),
	);
</script>

<section aria-label={m.chat_new_chat_pinned_paths()} class="min-w-0 space-y-2">
	{#if hasOtherPins || showAll}
		<button
			type="button"
			aria-pressed={showAll}
			class="min-h-7 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11 {showAll
				? 'bg-accent text-accent-foreground'
				: ''}"
			onclick={() => {
				showAll = !showAll;
			}}>{m.chat_new_chat_pinned_paths_all_machines()}</button
		>
	{/if}
	<div class={showAll ? 'max-h-52 space-y-3 overflow-y-auto overscroll-contain p-0.5' : ''}>
		{#each visibleGroups as group (group.executorId)}
			{@const executor = executors.get(group.executorId)}
			{@const label = executor?.label ?? group.executorId}
			{@const ready = executors.isReady(group.executorId)}
			<div role="group" aria-label={label} class="min-w-0 space-y-1.5">
				{#if showAll || !ready}
					<p class="flex flex-wrap items-baseline gap-x-2 px-0.5 text-xs text-muted-foreground">
						<span class="min-w-0 break-all font-medium">{label}</span>
						{#if !ready}
							<span id={`${id}-${group.executorId}-status`}
								>{executor
									? executorStatus(executor)
									: m.chat_new_chat_pinned_paths_unavailable_executor()}</span
							>
						{/if}
					</p>
				{/if}
				<ProjectPinnedPathList
					pinnedProjectPaths={group.paths}
					selectedPath={form.executorId === group.executorId ? form.projectPath : ''}
					labelPrefix={showAll ? label : undefined}
					statusId={!ready ? `${id}-${group.executorId}-status` : undefined}
					disabled={!ready || form.isUpdatingPinnedPath}
					onSelect={(path) => pins.select(group.executorId, path)}
				/>
			</div>
		{:else}
			<p
				class="w-full rounded-md bg-muted/30 px-2.5 py-1 text-center text-xs text-muted-foreground"
			>
				{m.chat_new_chat_star_bookmark()}
			</p>
		{/each}
	</div>
</section>
