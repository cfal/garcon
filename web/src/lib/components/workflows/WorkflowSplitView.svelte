<script module lang="ts">
	export function focusWorkflowDetail(heading: HTMLElement | undefined): void {
		const overview = heading?.closest('.workflow-split')?.querySelector('.workflow-overview');
		if (overview && getComputedStyle(overview).display === 'none') heading?.focus();
	}
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { nativeWorkspaceScrollRegion } from '$lib/workspace/workspace-scroll-region';

	let {
		showingDetail,
		overview,
		inspector,
	}: {
		showingDetail: boolean;
		overview: Snippet;
		inspector: Snippet;
	} = $props();
</script>

<div class="@container/workflow-split min-h-0 flex-1 overflow-hidden">
	<div class="workflow-split grid h-full min-h-0" data-detail={showingDetail}>
		<div
			class="workflow-overview min-h-0 min-w-0 overflow-auto"
			{@attach nativeWorkspaceScrollRegion('primary')}
		>
			{@render overview()}
		</div>
		<div
			class="workflow-inspector min-h-0 min-w-0 overflow-auto"
			{@attach nativeWorkspaceScrollRegion('contextual')}
		>
			{@render inspector()}
		</div>
	</div>
</div>

<style>
	@container workflow-split (min-width: 43rem) {
		.workflow-split {
			grid-template-columns: minmax(0, 1fr) minmax(19rem, 40%);
		}
		.workflow-inspector {
			border-inline-start: 1px solid hsl(var(--border));
		}
	}
	@container workflow-split (width < 43rem) {
		.workflow-split[data-detail='true'] .workflow-overview,
		.workflow-split[data-detail='false'] .workflow-inspector {
			display: none;
		}
	}
</style>
