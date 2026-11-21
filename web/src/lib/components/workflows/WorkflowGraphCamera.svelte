<script lang="ts">
	import { useSvelteFlow } from '@xyflow/svelte';
	import {
		workflowGraphFocusOffset,
		type WorkflowGraphFocus,
	} from '$lib/workflows/definition/workflow-graph';

	let {
		surface,
		focusRequest,
	}: {
		surface: HTMLDivElement | undefined;
		focusRequest: WorkflowGraphFocus | null;
	} = $props();
	const camera = useSvelteFlow();

	$effect(() => {
		const graph = surface;
		const request = focusRequest;
		if (!graph || !request) return;
		let cancelled = false;
		// The narrow inspector hides the graph until the Back update reaches layout.
		const frame = requestAnimationFrame(async () => {
			const node = Array.from(
				graph.querySelectorAll<HTMLButtonElement>('button[data-workflow-step]'),
			).find((button) => button.dataset.workflowStep === request.stepId);
			const bounds = graph.getBoundingClientRect();
			if (node && bounds.width && bounds.height) {
				const shift = workflowGraphFocusOffset(bounds, node.getBoundingClientRect());
				if (shift.x || shift.y) {
					const { x, y, zoom } = camera.getViewport();
					await camera.setViewport({ x: x + shift.x, y: y + shift.y, zoom });
				}
				if (!cancelled) node.focus({ preventScroll: true });
			}
			if (!cancelled) request.complete();
		});
		return () => {
			cancelled = true;
			cancelAnimationFrame(frame);
		};
	});
</script>
