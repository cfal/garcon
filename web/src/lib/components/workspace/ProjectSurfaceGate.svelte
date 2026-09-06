<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as m from '$lib/paraglide/messages.js';
	import type { WorkspaceProjectState } from '$lib/workspace/workspace-context.svelte.js';
	import { getProjectResolution } from '$lib/context';
	import type { ProjectTarget } from '$shared/project-resolution';
	import ProjectAvailabilityNotice from './ProjectAvailabilityNotice.svelte';

	let {
		projectState,
		retainedProjectPath,
		retainedEffectiveProjectKey,
		target,
		onChooseFolder,
		children,
	}: {
		projectState: WorkspaceProjectState;
		retainedProjectPath: string | null;
		retainedEffectiveProjectKey: string | null;
		target: ProjectTarget | null;
		onChooseFolder?: () => void;
		children: Snippet;
	} = $props();
	const projectResolution = getProjectResolution();

	const synchronized = $derived.by(() => {
		if (projectState.kind === 'absent') return retainedEffectiveProjectKey === null;
		return projectState.kind === 'available'
			&& retainedEffectiveProjectKey === projectState.project.effectiveProjectKey;
	});
	const resolvingSamePath = $derived(
		(projectState.kind === 'unchecked' || projectState.kind === 'resolving') &&
			retainedEffectiveProjectKey !== null &&
			retainedProjectPath === projectState.context.projectPath,
	);
	const blocked = $derived(projectState.kind === 'resolving' || !synchronized);
	const concealed = $derived(blocked && !resolvingSamePath);

	function retry(): void {
		if (projectState.kind === 'absent' || projectState.kind === 'available') return;
		if (!target) return;
		const lease = projectResolution.retain(target);
		void lease.retry().finally(() => lease.release());
	}
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
	{#if concealed && (projectState.kind === 'unchecked' || projectState.kind === 'resolving')}
		<div
			class="absolute inset-0 grid place-items-center bg-background px-6 text-center text-sm text-muted-foreground"
			role="status"
		>
			{m.workspace_resolving_project()}
		</div>
	{:else if concealed && projectState.kind === 'unavailable'}
		<div class="absolute inset-0 grid place-items-center bg-background px-6">
			<ProjectAvailabilityNotice
				projectPath={projectState.context.projectPath}
				reason={projectState.reason}
				onRetry={retry}
				{onChooseFolder}
			/>
		</div>
	{:else if concealed && projectState.kind === 'request-failed'}
		<div class="absolute inset-0 grid place-items-center bg-background px-6">
			<ProjectAvailabilityNotice
				projectPath={projectState.context.projectPath}
				requestError={projectState.message}
				onRetry={retry}
				{onChooseFolder}
			/>
		</div>
	{:else if blocked}
		<span class="sr-only" role="status">{m.workspace_resolving_project()}</span>
	{/if}
</div>
