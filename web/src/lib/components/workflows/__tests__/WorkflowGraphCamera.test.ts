import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import type { useSvelteFlow } from '@xyflow/svelte';
import WorkflowGraphCamera from '../WorkflowGraphCamera.svelte';

const camera = vi.hoisted(
	() =>
		({
			getViewport: vi.fn(() => ({ x: 97, y: 243, zoom: 1 })),
			setViewport: vi.fn(async () => true),
		}) satisfies Pick<ReturnType<typeof useSvelteFlow>, 'getViewport' | 'setViewport'>,
);

vi.mock('@xyflow/svelte', () => ({ useSvelteFlow: () => camera }));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	document.querySelector('[data-workflow-camera-fixture]')?.remove();
});

function graphWithNode(x: number) {
	const surface = document.createElement('div');
	surface.dataset.workflowCameraFixture = '';
	const step = document.createElement('button');
	step.dataset.workflowStep = 'added-step';
	surface.append(step);
	document.body.append(surface);
	vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 294, 390, 550));
	vi.spyOn(step, 'getBoundingClientRect').mockReturnValue(new DOMRect(x, 537, 196, 64));
	return { surface, step };
}

it('restores the focused dependent node from outside the 390px graph without changing zoom', async () => {
	const { surface, step } = graphWithNode(397);
	const complete = vi.fn();
	const view = render(WorkflowGraphCamera, { surface, focusRequest: null });
	expect(camera.setViewport).not.toHaveBeenCalled();
	await view.rerender({ focusRequest: { stepId: 'added-step', complete } });
	await waitFor(() => expect(complete).toHaveBeenCalledOnce());
	expect(camera.setViewport).toHaveBeenCalledExactlyOnceWith({ x: -114, y: 243, zoom: 1 });
	expect(document.activeElement).toBe(step);
});

it('leaves the current pan and zoom alone when the restored node is already in view', async () => {
	const { surface, step } = graphWithNode(97);
	const complete = vi.fn();
	render(WorkflowGraphCamera, { surface, focusRequest: { stepId: 'added-step', complete } });
	await waitFor(() => expect(complete).toHaveBeenCalledOnce());
	expect(camera.setViewport).not.toHaveBeenCalled();
	expect(document.activeElement).toBe(step);
});
