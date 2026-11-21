<script lang="ts">
	import { setExecutors } from '$lib/context';
	import { ExecutorsStore } from '$lib/executors/executors-store.svelte';
	import NewWorkflow from '../NewWorkflow.svelte';

	let { onRunStarted }: { onRunStarted: (id: string) => void } = $props();
	setExecutors(new ExecutorsStore());
</script>

<NewWorkflow context={null} {onRunStarted} onOpenRun={() => {}} />
