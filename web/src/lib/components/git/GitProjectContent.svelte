<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { GitProjectSelectionController } from '$lib/git/targets/git-project-selection.svelte.js';
	import ProjectAvailabilityNotice from '$lib/components/workspace/ProjectAvailabilityNotice.svelte';
	import * as m from '$lib/paraglide/messages.js';

	let {
		selection,
		ready = true,
		children,
	}: {
		selection: GitProjectSelectionController;
		ready?: boolean;
		children: Snippet;
	} = $props();
	const project = $derived(selection.projectState);
	const blocked = $derived(project.kind !== 'available' || !ready);
</script>

<div class="relative min-h-0 min-w-0 flex-1" aria-busy={blocked} data-git-project-content>
	<div
		class="flex h-full min-h-0 min-w-0 flex-col"
		class:invisible={blocked}
		inert={blocked}
		aria-hidden={blocked}
	>
		{@render children()}
	</div>
	{#if blocked}
		<div
			class="absolute inset-0 grid place-items-center overflow-auto bg-background p-4 text-center text-sm text-muted-foreground"
		>
			{#if project.kind === 'unavailable'}
				<ProjectAvailabilityNotice
					projectPath={project.context.projectPath}
					reason={project.reason}
					onRetry={() => void selection.retry()}
				/>
			{:else if project.kind === 'request-failed'}
				<ProjectAvailabilityNotice
					projectPath={project.context.projectPath}
					requestError={project.message}
					onRetry={() => void selection.retry()}
				/>
			{:else if project.kind === 'absent'}
				<p role="status">{m.git_panel_select_project()}</p>
			{:else}
				<p role="status">{m.workspace_resolving_project()}</p>
			{/if}
		</div>
	{/if}
</div>
