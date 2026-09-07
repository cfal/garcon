<script lang="ts">
	import type { ProjectUnavailableReason } from '$shared/project-resolution';
	import * as m from '$lib/paraglide/messages.js';

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

<div class="max-w-md text-center" role="status">
	<p class="font-medium text-foreground">{m.workspace_project_unavailable()}</p>
	<p class="mt-1 text-sm text-muted-foreground">{detail}</p>
	<p class="mt-1 break-all text-xs text-muted-foreground">{projectPath}</p>
	<div class="mt-3 flex justify-center gap-2">
		<button
			type="button"
			class="rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
			onclick={onRetry}
		>
			{m.common_retry()}
		</button>
		{#if onChooseFolder}
			<button
				type="button"
				class="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring"
				onclick={onChooseFolder}
			>
				{m.workspace_choose_project_folder()}
			</button>
		{/if}
	</div>
</div>
