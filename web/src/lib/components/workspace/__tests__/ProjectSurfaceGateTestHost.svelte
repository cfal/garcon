<script lang="ts">
	import ProjectSurfaceGate from '../ProjectSurfaceGate.svelte';
	import type { WorkspaceProjectState } from '$lib/workspace/workspace-context.svelte.js';

	let {
		projectState,
		retainedProjectPath,
		retainedEffectiveProjectKey,
	}: {
		projectState: WorkspaceProjectState;
		retainedProjectPath: string | null;
		retainedEffectiveProjectKey: string | null;
	} = $props();
</script>

<ProjectSurfaceGate {projectState} {retainedProjectPath} {retainedEffectiveProjectKey}>
	<button type="button">Project action</button>
</ProjectSurfaceGate>
