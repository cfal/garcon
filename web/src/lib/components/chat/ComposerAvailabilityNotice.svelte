<script lang="ts">
	import type { ComposerAvailabilityNotice } from '$lib/chat/composer/composer-availability.js';
	import AvailabilityNotice from '$lib/components/workspace/AvailabilityNotice.svelte';
	import ProjectAvailabilityNotice from '$lib/components/workspace/ProjectAvailabilityNotice.svelte';
	import * as m from '$lib/paraglide/messages.js';

	let {
		notice,
		onRetryProject,
		onChooseProjectFolder,
		onRetryCatalog,
	}: {
		notice: ComposerAvailabilityNotice;
		onRetryProject: () => void;
		onChooseProjectFolder?: () => void;
		onRetryCatalog: () => void;
	} = $props();
</script>

<div
	class="mb-2 rounded-lg border border-border bg-card px-4 py-3"
	data-composer-availability-notice={notice.kind}
	data-project-availability-notice={notice.kind === 'project-unavailable' ? '' : undefined}
>
	{#if notice.kind === 'project-unavailable'}
		<ProjectAvailabilityNotice
			projectPath={notice.projectPath}
			reason={notice.reason}
			requestError={notice.requestError}
			onRetry={onRetryProject}
			onChooseFolder={onChooseProjectFolder}
		/>
	{:else if notice.kind === 'catalog-failed'}
		<AvailabilityNotice
			title={m.chat_composer_catalog_failed()}
			detail={notice.message}
			onRetry={onRetryCatalog}
		/>
	{:else if notice.kind === 'provider-unavailable'}
		<AvailabilityNotice
			title={m.chat_composer_model_unavailable()}
			detail={m.chat_composer_model_unavailable_detail()}
		/>
	{:else if notice.kind === 'executor-reconnecting'}
		<AvailabilityNotice
			title={m.chat_composer_executor_reconnecting()}
			detail={m.chat_composer_executor_reconnecting_detail({ label: notice.executorLabel })}
		/>
	{:else if notice.kind === 'executor-removed'}
		<AvailabilityNotice
			title={m.chat_composer_executor_unavailable()}
			detail={m.chat_composer_executor_removed_detail()}
			subject={notice.executorId}
		/>
	{:else}
		<AvailabilityNotice
			title={m.chat_composer_executor_unavailable()}
			detail={m.chat_composer_executor_unavailable_detail({ label: notice.executorLabel })}
		/>
	{/if}
</div>
