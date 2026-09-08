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

afterEach(cleanup);

describe('Canvas connection interactions', () => {
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
