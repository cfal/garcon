<script lang="ts">
	import { untrack } from 'svelte';
	import { setExecutors } from '$lib/context';
	import { ExecutorsStore } from '$lib/executors/executors-store.svelte';
	import NewWorkflow from '../NewWorkflow.svelte';
	import { provideWorkflowStudioSession } from '$lib/workflows/definition/workflow-studio-session.svelte';
	import type { WorkflowLaunchContext } from '$lib/workflows/launch/workflow-locations';

	let {
		onRunStarted,
		open = true,
		context = null,
		executors = new ExecutorsStore(),
	}: {
		onRunStarted: (id: string) => void;
		open?: boolean;
		context?: WorkflowLaunchContext | null;
		executors?: ExecutorsStore;
	} = $props();
	setExecutors(untrack(() => executors));
	provideWorkflowStudioSession(() => open);
</script>

{#if open}
	{#key context}
		<NewWorkflow {context} {onRunStarted} onOpenRun={onRunStarted} />
	{/key}
{/if}
