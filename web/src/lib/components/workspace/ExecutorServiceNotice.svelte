<script lang="ts">
	import type { ExecutorServiceNotice } from '$lib/executors/executor-service-notice.js';
	import * as m from '$lib/paraglide/messages.js';
	import AvailabilityNotice from './AvailabilityNotice.svelte';

	let { notice }: { notice: ExecutorServiceNotice } = $props();
</script>

<div data-executor-service-notice={notice.kind}>
	{#if notice.kind === 'executor-removed'}
		<AvailabilityNotice
			title={m.workspace_executor_unavailable()}
			detail={m.workspace_executor_removed_detail()}
			subject={notice.executorId}
		/>
	{:else if notice.kind === 'executor-reconnecting'}
		<AvailabilityNotice
			title={m.workspace_executor_reconnecting()}
			detail={m.workspace_executor_reconnecting_detail({ label: notice.executorLabel })}
		/>
	{:else if notice.kind === 'executor-unavailable'}
		<AvailabilityNotice
			title={m.workspace_executor_unavailable()}
			detail={m.workspace_executor_unavailable_detail({ label: notice.executorLabel })}
		/>
	{:else if notice.service === 'files'}
		<AvailabilityNotice
			title={m.workspace_files_unavailable()}
			detail={m.workspace_files_unsupported_detail({ label: notice.executorLabel })}
		/>
	{:else}
		<AvailabilityNotice
			title={m.workspace_git_unavailable()}
			detail={m.workspace_git_unsupported_detail({ label: notice.executorLabel })}
		/>
	{/if}
</div>
