<script lang="ts">
	import WorkflowRunView from './WorkflowRunView.svelte';
	import './workflow-form.css';

	let {
		runId,
		onOpenChat,
		visible = true,
	}: {
		runId: string;
		onOpenChat: (chatId: string) => void;
		visible?: boolean;
	} = $props();
</script>

{#key runId}
	<WorkflowRunView {runId} {onOpenChat} {visible} />
{/key}
