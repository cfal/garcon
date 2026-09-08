import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { abortInteractions, type useStore } from '@xyflow/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { CanvasSession, type CanvasSessionPort } from '$lib/chat-canvas/canvas-session.svelte';
import { canvas, recoveryMemory } from '$lib/chat-canvas/__tests__/canvas-fixtures';
import type { WorkspaceWindowDndController } from '$lib/workspace/window-dnd.svelte';
import type { CanvasFlowNode } from '../canvas-node-types';
import CanvasFlowTestHost from './CanvasFlowTestHost.svelte';

type FlowStore = ReturnType<typeof useStore<CanvasFlowNode>>;

vi.mock('$lib/context', () => ({
	getWorkspaceWindowDnd: () =>
		({
			registerChatDropTarget: () => () => {},
		}) satisfies Pick<WorkspaceWindowDndController, 'registerChatDropTarget'>,
}));

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

function createSession() {
	const original = canvas();
	const api = {
		get: async () => original,
		update: async (request) => canvas(request.content, request.expectedRevision + 1),
	} satisfies CanvasSessionPort;
	return new CanvasSession(original, api, recoveryMemory().port, vi.fn());
}

async function dragNode(container: HTMLElement) {
	await fireEvent.mouseDown(container.querySelector('[data-id="box-a"] .canvas-drag-handle')!, {
		view: window,
		clientX: 100,
		clientY: 100,
		buttons: 1,
	});
	await fireEvent.mouseMove(window, { view: window, clientX: 150, clientY: 130, buttons: 1 });
}

describe('Canvas gesture lifetime', () => {
	it.each(['touchcancel', 'multitouch'] as const)(
		'cancels a touch drag on %s and admits a fresh mouse drag',
		async (reason) => {
			const touchPoints = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints');
			Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 2 });
			const session = createSession();
			try {
				const view = render(CanvasFlowTestHost, { session });
				await tick();
				const source = view.container.querySelector('[data-id="box-a"] .canvas-drag-handle')!;
				const touch = { identifier: 1, clientX: 100, clientY: 100, target: source };
				await fireEvent.touchStart(source, { touches: [touch], changedTouches: [touch] });
				const moved = { ...touch, clientX: 150, clientY: 130 };
				await fireEvent.touchMove(source, { touches: [moved], changedTouches: [moved] });
				expect(session.interacting).toBe(true);
				if (reason === 'touchcancel') {
					await fireEvent.touchCancel(source, { touches: [], changedTouches: [moved] });
				} else {
					const second = { ...moved, identifier: 2 };
					await fireEvent.touchStart(source, {
						touches: [moved, second],
						changedTouches: [second],
					});
				}
				expect(session.interacting).toBe(false);
				await fireEvent.touchEnd(source, { touches: [], changedTouches: [moved] });
				expect(session.dirty).toBe(false);
				await dragNode(view.container);
				expect(session.interacting).toBe(true);
				await fireEvent.mouseMove(window, {
					view: window,
					clientX: 190,
					clientY: 160,
					buttons: 1,
				});
				await fireEvent.mouseUp(window, { view: window, clientX: 190, clientY: 160 });
				await tick();
				expect(session.interacting).toBe(false);
				expect(session.dirty).toBe(true);
			} finally {
				await fireEvent.mouseUp(window, { view: window });
				cleanup();
				session.dispose();
				if (touchPoints) Object.defineProperty(navigator, 'maxTouchPoints', touchPoints);
				else Reflect.deleteProperty(navigator, 'maxTouchPoints');
			}
		},
	);

	it('cancels marquee selection and its pending auto-pan when editing is disabled', async () => {
		const session = createSession();
		let flowStore!: FlowStore;
		const pendingPan = Promise.withResolvers<boolean>();
		try {
			const view = render(CanvasFlowTestHost, {
				session,
				onstore: (value) => {
					flowStore = value;
				},
			});
			await tick();
			flowStore.selectionKeyPressed = true;
			await tick();
			const pan = vi.spyOn(flowStore, 'panBy').mockReturnValue(pendingPan.promise);
			const frame = vi.spyOn(window, 'requestAnimationFrame');
			const pane = view.container.querySelector('.svelte-flow__pane')!;
			await fireEvent.pointerDown(pane, {
				pointerId: 11,
				isPrimary: true,
				button: 0,
				clientX: 20,
				clientY: 20,
			});
			await fireEvent.pointerMove(pane, { pointerId: 12, clientX: 70, clientY: 80 });
			expect(session.interacting).toBe(false);
			await fireEvent.pointerMove(pane, { pointerId: 11, clientX: 70, clientY: 80 });
			expect(session.interacting).toBe(true);
			expect(pan).toHaveBeenCalledTimes(1);
			await view.rerender({ editing: false });
			expect(session.interacting).toBe(false);
			expect(flowStore.selectionRect).toBeNull();
			const frames = frame.mock.calls.length;
			pendingPan.resolve(true);
			await pendingPan.promise;
			await tick();
			expect(frame).toHaveBeenCalledTimes(frames);
			expect(flowStore.selectionRect).toBeNull();
		} finally {
			pendingPan.resolve(false);
			cleanup();
			session.dispose();
		}
	});

	it.each(['abort', 'unmount'] as const)(
		'does not re-arm pending drag auto-pan after %s',
		async (reason) => {
			const session = createSession();
			let flowStore!: FlowStore;
			const pendingPan = Promise.withResolvers<boolean>();
			try {
				const view = render(CanvasFlowTestHost, {
					session,
					onstore: (value) => {
						flowStore = value;
					},
				});
				await tick();
				const pan = vi.spyOn(flowStore, 'panBy').mockReturnValue(pendingPan.promise);
				const update = vi.spyOn(flowStore, 'updateNodePositions');
				const frame = vi.spyOn(window, 'requestAnimationFrame');
				await dragNode(view.container);
				await fireEvent.mouseMove(window, { view: window, clientX: 180, clientY: 150, buttons: 1 });
				expect(pan).toHaveBeenCalledTimes(1);
				expect(session.interacting).toBe(true);
				if (reason === 'abort') abortInteractions(flowStore.domNode);
				else cleanup();
				await tick();
				expect(session.interacting).toBe(false);
				if (reason === 'abort') {
					await dragNode(view.container);
					expect(session.interacting).toBe(true);
				}
				const updates = update.mock.calls.length;
				const frames = frame.mock.calls.length;
				pendingPan.resolve(true);
				await pendingPan.promise;
				await tick();
				expect(update).toHaveBeenCalledTimes(updates);
				expect(frame).toHaveBeenCalledTimes(frames);
				expect(pan).toHaveBeenCalledTimes(1);
			} finally {
				pendingPan.resolve(false);
				await fireEvent.mouseUp(window, { view: window });
				cleanup();
				session.dispose();
			}
		},
	);

	it('does not cancel another graph or remove its mouse listeners when an old graph aborts', async () => {
		const firstSession = createSession();
		const secondSession = createSession();
		let firstStore!: FlowStore;
		try {
			const first = render(CanvasFlowTestHost, {
				session: firstSession,
				onstore: (value) => {
					firstStore = value;
				},
			});
			const second = render(CanvasFlowTestHost, { session: secondSession });
			await tick();
			await dragNode(first.container);
			expect(firstSession.interacting).toBe(true);
			await dragNode(second.container);
			expect(secondSession.interacting).toBe(true);
			abortInteractions(firstStore.domNode);
			expect(firstSession.interacting).toBe(false);
			expect(secondSession.interacting).toBe(true);
			await fireEvent.mouseMove(window, { view: window, clientX: 190, clientY: 160, buttons: 1 });
			await fireEvent.mouseUp(window, { view: window, clientX: 190, clientY: 160 });
			await tick();
			expect(secondSession.interacting).toBe(false);
			expect(firstSession.dirty).toBe(false);
			expect(secondSession.dirty).toBe(true);
		} finally {
			await fireEvent.mouseUp(window, { view: window });
			cleanup();
			firstSession.dispose();
			secondSession.dispose();
		}
	});
});
