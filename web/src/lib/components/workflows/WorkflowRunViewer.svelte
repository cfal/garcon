<script lang="ts">
	import type { WorkflowLaunchContext } from '$lib/workflows/launch/workflow-locations';
	import type { WorkflowRevision, WorkflowRunDetail } from '$shared/workflow-runs';
	import WorkflowRunView from './WorkflowRunView.svelte';
	import './workflow-form.css';

	let {
		runId,
		onOpenChat,
		onOpenEditor,
		onRunAgain,
		onRunName,
		visible = true,
	}: {
		runId: string;
		onOpenChat: (chatId: string) => void;
		onOpenEditor?: (revision: WorkflowRevision, context: WorkflowLaunchContext | null) => void;
		onRunAgain?: (run: WorkflowRunDetail) => void;
		onRunName?: (name: string) => void;
		visible?: boolean;
	} = $props();
</script>

{#key runId}
	<WorkflowRunView {runId} {onOpenChat} {onOpenEditor} {onRunAgain} {onRunName} {visible} />
{/key}
