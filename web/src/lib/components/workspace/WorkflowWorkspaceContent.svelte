<script module lang="ts">
	import { lazyRenderer } from '$lib/utils/lazy-renderer.js';

	const newWorkflowRenderer = lazyRenderer(
		() => import('$lib/components/workflows/NewWorkflow.svelte'),
	);
	const runViewerRenderer = lazyRenderer(
		() => import('$lib/components/workflows/WorkflowRunViewer.svelte'),
	);
</script>

<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import * as m from '$lib/paraglide/messages.js';
	import { getWorkflowStudioSession } from '$lib/workflows/definition/workflow-studio-session.svelte';
	import { getWorkflowNavigation } from '$lib/workflows/navigation/workflow-navigation-context';
	import type { WorkflowSurfaceDescriptor } from '$lib/workspace/surface-types';

	let { surface, visible }: { surface: WorkflowSurfaceDescriptor; visible: boolean } = $props();
	const source = untrack(() => surface);
	const navigation = getWorkflowNavigation();
	const session = getWorkflowStudioSession();
	let destroyed = false;
	onDestroy(() => {
		destroyed = true;
	});
	function openRun(runId: string): void {
		if (!destroyed) navigation.openRun(runId, source);
	}
</script>

{#snippet loading()}
	<div class="grid h-full place-items-center text-sm text-muted-foreground" role="status">
		{m.workflow_nav_loading()}
	</div>
{/snippet}

{#if source.type === 'new-workflow'}
	{#await newWorkflowRenderer()}
		{@render loading()}
	{:then NewWorkflow}
		<NewWorkflow context={source.context} onRunStarted={openRun} onOpenRun={openRun} />
	{/await}
{:else}
	{#await runViewerRenderer()}
		{@render loading()}
	{:then WorkflowRunViewer}
		<WorkflowRunViewer
			runId={source.runId}
			{visible}
			onOpenEditor={(revision, context) => {
				if (destroyed) return;
				session.openRevisionInEditor(revision, context);
				navigation.openNewWorkflow(source);
			}}
			onRunAgain={(run) => {
				if (destroyed) return;
				session.seedRunAgain(run);
				navigation.openNewWorkflow(source);
			}}
			onOpenChat={(chatId) => {
				if (!destroyed) navigation.openChat(chatId, source);
			}}
		/>
	{/await}
{/if}
