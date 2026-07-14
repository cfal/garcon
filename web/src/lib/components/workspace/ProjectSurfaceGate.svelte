<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as m from '$lib/paraglide/messages.js';
	import type { WorkspaceProjectState } from '$lib/workspace/workspace-context.svelte.js';

	let {
		projectState,
		retainedProjectPath,
		retainedEffectiveProjectKey,
		children,
	}: {
		projectState: WorkspaceProjectState;
		retainedProjectPath: string | null;
		retainedEffectiveProjectKey: string | null;
		children: Snippet;
	} = $props();

	const synchronized = $derived.by(() => {
		if (projectState.kind === 'resolving') return false;
		if (projectState.kind === 'absent') return retainedEffectiveProjectKey === null;
		return retainedEffectiveProjectKey === projectState.project.effectiveProjectKey;
	});
	const resolvingSamePath = $derived(
		projectState.kind === 'resolving' &&
			retainedEffectiveProjectKey !== null &&
			retainedProjectPath === projectState.context.projectPath,
	);
	const blocked = $derived(projectState.kind === 'resolving' || !synchronized);
	const concealed = $derived(blocked && !resolvingSamePath);
</script>

<div class="relative h-full min-h-0 min-w-0" aria-busy={blocked}>
	<div
		class="h-full min-h-0 min-w-0"
		class:invisible={concealed}
		class:pointer-events-none={concealed}
		inert={blocked}
		aria-hidden={concealed}
	>
		{@render children()}
	</div>
	{#if concealed && projectState.kind !== 'absent'}
		<div
			class="absolute inset-0 grid place-items-center bg-background px-6 text-center text-sm text-muted-foreground"
			role="status"
		>
			{m.workspace_resolving_project()}
		</div>
	{:else if blocked}
		<span class="sr-only" role="status">{m.workspace_resolving_project()}</span>
	{/if}
</div>
