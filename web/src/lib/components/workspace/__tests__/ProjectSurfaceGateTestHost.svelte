<script lang="ts">
	import { onDestroy } from 'svelte';
	import ProjectSurfaceGate from '../ProjectSurfaceGate.svelte';
	import { setProjectResolution } from '$lib/context';
	import { ProjectResolutionStore } from '$lib/workspace/project-resolution-store.svelte.js';
	import type { WorkspaceProjectState } from '$lib/workspace/workspace-context.svelte.js';
	import type { ProjectTarget } from '$shared/project-resolution';

	let {
		projectState,
		retainedProjectPath,
		retainedEffectiveProjectKey,
		target = null,
		onChooseFolder,
		fetchResolution,
	}: {
		projectState: WorkspaceProjectState;
		retainedProjectPath: string | null;
		retainedEffectiveProjectKey: string | null;
		target?: ProjectTarget | null;
		onChooseFolder?: () => void;
		fetchResolution?: ConstructorParameters<typeof ProjectResolutionStore>[0];
	} = $props();

	const projectResolution = new ProjectResolutionStore(
		(target, signal) =>
			fetchResolution?.(target, signal) ??
			Promise.reject(new Error('No project resolver configured')),
	);
	setProjectResolution(projectResolution);
	onDestroy(() => projectResolution.destroy());
</script>

<ProjectSurfaceGate
	{projectState}
	{retainedProjectPath}
	{retainedEffectiveProjectKey}
	{target}
	{onChooseFolder}
>
	<button type="button">Project action</button>
</ProjectSurfaceGate>
