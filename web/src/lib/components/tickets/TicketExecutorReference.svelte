<script lang="ts">
	import Monitor from '@lucide/svelte/icons/monitor';
	import { getExecutors, hasExecutors } from '$lib/context';
	let { executorId }: { executorId: string } = $props();
	const executors = hasExecutors() ? getExecutors() : null;
</script>

<span class="inline-flex min-w-0 items-center gap-1" title={executorId}>
	<Monitor size={12} class="shrink-0" />
	<span class="truncate">{executors?.get(executorId)?.label ?? executorId}</span>
</span>
