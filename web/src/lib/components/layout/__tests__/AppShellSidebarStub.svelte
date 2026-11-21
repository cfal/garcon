<script lang="ts">
	import type { SidebarChatListProjection } from '$lib/sidebar/display/sidebar-row-model';
	import type { SidebarWorkflowControls } from '../../sidebar/sidebar-workflow-controls';
	let { onChatSelect, onNewWorkflow, projection, workflowControls }: {
		onChatSelect: (chatId: string) => void;
		onNewWorkflow: () => void;
		projection: SidebarChatListProjection;
		workflowControls: SidebarWorkflowControls;
	} = $props();
</script>

<button type="button" onclick={() => onChatSelect('chat-test')}>Select test chat</button>
<button type="button" onclick={onNewWorkflow}>New Workflow</button>
{#each projection.rowModel.rows as row (row.key)}
	{#if row.type === 'workflow-run'}
		<button type="button" onclick={() => workflowControls.openRun(row.run.id)}>{row.run.name}</button>
	{/if}
{/each}
