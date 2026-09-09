import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { CanvasSession, type CanvasSessionPort } from '$lib/chat-canvas/canvas-session.svelte';
import { canvas, recoveryMemory } from '$lib/chat-canvas/__tests__/canvas-fixtures';
import type { WorkspaceWindowDndController } from '$lib/workspace/window-dnd.svelte';
import CanvasFlowTestHost from './CanvasFlowTestHost.svelte';

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

describe('Canvas connection interactions', () => {
	it('removes active drag listeners when the graph unmounts without mouse-up', async () => {
		const original = canvas();
		const api = {
			get: async () => original,
			update: async (request) => canvas(request.content, request.expectedRevision + 1),
		} satisfies CanvasSessionPort;
		const session = new CanvasSession(original, api, recoveryMemory().port, vi.fn());
		const add = vi.spyOn(window, 'addEventListener');
		const remove = vi.spyOn(window, 'removeEventListener');
		try {
			const { container } = render(CanvasFlowTestHost, { session });
			await tick();
			add.mockClear();
			await fireEvent.mouseDown(container.querySelector('[data-id="box-a"] .canvas-drag-handle')!, {
				view: window,
				clientX: 100,
				clientY: 100,
				buttons: 1,
			});
			await fireEvent.mouseMove(window, { view: window, clientX: 150, clientY: 130, buttons: 1 });
			expect(session.interacting).toBe(true);
			const listeners = add.mock.calls.filter(
				([type]) => type === 'mousemove' || type === 'mouseup',
			);
			expect(listeners).toHaveLength(2);
			cleanup();
			for (const [type, listener] of listeners) {
				expect(
					remove.mock.calls.some(
						([removedType, removedListener]) =>
							removedType === type && removedListener === listener,
					),
				).toBe(true);
			}
			expect(session.interacting).toBe(false);
		} finally {
			await fireEvent.mouseUp(window, { view: window });
			session.dispose();
		}
	});

	it('releases an armed source when editing is disabled', async () => {
		const original = canvas();
		const api = {
			get: async () => original,
			update: async (request) => canvas(request.content, request.expectedRevision + 1),
		} satisfies CanvasSessionPort;
		const session = new CanvasSession(original, api, recoveryMemory().port, vi.fn());
		try {
			const view = render(CanvasFlowTestHost, { session });
			await tick();
			const handle = (id: string) =>
				view.container.querySelector<HTMLElement>(
					`.svelte-flow__node[data-id="${id}"] [data-handleid="right"]`,
				)!;
			await fireEvent.click(handle('box-a'));
			expect(session.interacting).toBe(true);
			await view.rerender({ editing: false });
			expect(session.interacting).toBe(false);
			await view.rerender({ editing: true });
			await fireEvent.click(handle('box-b'));
			expect(session.interacting).toBe(true);
			cleanup();
			expect(session.interacting).toBe(false);
		} finally {
			session.dispose();
		}
	});

	it.each(['remove', 'reload'] as const)(
		'releases the armed source after %s',
		async (operation) => {
			const original = canvas();
			const latest = canvas(
				{
					...original.content,
					nodes: original.content.nodes.filter((node) => node.id === 'box-b'),
					connections: [],
				},
				2,
			);
			const api = {
				get: async () => latest,
				update: async (request) => canvas(request.content, request.expectedRevision + 1),
			} satisfies CanvasSessionPort;
			const session = new CanvasSession(original, api, recoveryMemory().port, vi.fn());
			try {
				const { container } = render(CanvasFlowTestHost, { session });
				await tick();
				const handle = (id: string) =>
					container.querySelector<HTMLElement>(
						`.svelte-flow__node[data-id="${id}"] [data-handleid="right"]`,
					)!;
				await fireEvent.click(handle('box-a'));
				expect(session.interacting).toBe(true);
				session.document.renameBox('box-a', 'Renamed source');
				await tick();
				expect(session.interacting).toBe(true);
				if (operation === 'remove') session.document.remove(new Set(['box-a']));
				else expect(await session.discardAndReload()).toBe(true);
				await tick();
				expect(session.interacting).toBe(false);
				await fireEvent.click(handle('box-b'));
				expect(session.interacting).toBe(true);
				cleanup();
				expect(session.interacting).toBe(false);
			} finally {
				session.dispose();
			}
		},
	);
});
