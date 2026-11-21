<script lang="ts">
	import { setExecutors } from '$lib/context';
	import { ExecutorsStore } from '$lib/executors/executors-store.svelte';
	import NewWorkflow from '../NewWorkflow.svelte';
	import { provideWorkflowStudioSession } from '$lib/workflows/definition/workflow-studio-session.svelte';
	import type { WorkflowLaunchContext } from '$lib/workflows/launch/workflow-locations';

	let {
		onRunStarted,
		open = true,
		context = null,
	}: {
		onRunStarted: (id: string) => void;
		open?: boolean;
		context?: WorkflowLaunchContext | null;
	} = $props();
	setExecutors(new ExecutorsStore());
	provideWorkflowStudioSession(() => open);
</script>

{#if open}
	{#key context}
		<NewWorkflow {context} {onRunStarted} onOpenRun={onRunStarted} />
	{/key}
{/if}
