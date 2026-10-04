<script lang="ts">
	import AgentCard from '../AgentCard.svelte';
	import AgentCliUpdatePanel from '../AgentCliUpdatePanel.svelte';
	let { executorId = 'local', loading = false }: { executorId?: string; loading?: boolean } = $props();
	let open = $state(false);
</script>

<AgentCard
	agentId="claude"
	agentName="Claude"
	auth={{ authenticated: false, canReauth: false, label: '', loading, error: null }}
	noLogin
	{open}
	onOpenChange={(value) => { open = value; }}
>
	<AgentCliUpdatePanel agentId="claude" {executorId} instanceId="instance-a" />
</AgentCard>
