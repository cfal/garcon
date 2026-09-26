<script lang="ts">
	import type { ProjectUnavailableReason } from '$shared/project-resolution';
	import * as m from '$lib/paraglide/messages.js';
	import AvailabilityNotice from './AvailabilityNotice.svelte';

	let {
		projectPath,
		reason,
		requestError,
		onRetry,
		onChooseFolder,
	}: {
		projectPath: string;
		reason?: ProjectUnavailableReason;
		requestError?: string;
		onRetry: () => void;
		onChooseFolder?: () => void;
	} = $props();

	const detail = $derived.by(() => {
		if (requestError) return requestError;
		switch (reason) {
			case 'not-a-directory':
				return m.workspace_project_not_directory();
			case 'outside-base':
				return m.workspace_project_outside_base();
			case 'permission-denied':
				return m.workspace_project_permission_denied();
			case 'not-found':
			default:
				return m.workspace_project_not_found();
		}
	});
</script>

<AvailabilityNotice
	title={m.workspace_project_unavailable()}
	{detail}
	subject={projectPath}
	{onRetry}
	action={onChooseFolder
		? { label: m.workspace_choose_project_folder(), onClick: onChooseFolder }
		: undefined}
/>
