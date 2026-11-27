<script lang="ts">
	import { untrack } from 'svelte';
	import {
		setWorkflowNavigation,
		type WorkflowNavigation,
	} from '$lib/workflows/navigation/workflow-navigation-context';
	import { createWorkspaceSurfaceCatalog } from '../workspace-surface-catalog.svelte.js';

	let {
		workflowNavigation,
		onCatalog,
	}: {
		workflowNavigation: WorkflowNavigation | null;
		onCatalog: (catalog: ReturnType<typeof createWorkspaceSurfaceCatalog>) => void;
	} = $props();

	untrack(() => {
		if (workflowNavigation) setWorkflowNavigation(workflowNavigation);
		const catalog = createWorkspaceSurfaceCatalog(() => undefined);
		onCatalog(catalog);
	});
</script>
