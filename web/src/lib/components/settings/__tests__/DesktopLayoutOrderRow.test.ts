import { render, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

const dnd = vi.hoisted(() => ({
	dropTargetOptions: null as unknown,
}));

vi.mock('@atlaskit/pragmatic-drag-and-drop/combine', () => ({
	combine:
		(...cleanups: Array<() => void>) =>
		() =>
			cleanups.forEach((cleanup) => cleanup()),
}));

vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
	draggable: () => () => undefined,
	dropTargetForElements: (options: unknown) => {
		dnd.dropTargetOptions = options;
		return () => undefined;
	},
}));

vi.mock('@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge', () => ({
	attachClosestEdge: (data: Record<string, unknown>) => data,
	extractClosestEdge: (data: Record<string, unknown>) => data.closestEdge ?? null,
}));

const DesktopLayoutOrderRow = (await import('../DesktopLayoutOrderRow.svelte')).default;

describe('DesktopLayoutOrderRow', () => {
	it('forwards a pane drop with the closest edge', async () => {
		const onDrop = vi.fn();
		render(DesktopLayoutOrderRow, {
			pane: 'chat-list',
			label: 'Chat list',
			index: 0,
			count: 3,
			onMove: vi.fn(),
			onDrop,
		});

		await waitFor(() => expect(dnd.dropTargetOptions).toBeTruthy());
		const options = dnd.dropTargetOptions as {
			onDrop: (input: {
				source: { data: Record<string, unknown> };
				self: { data: Record<string, unknown> };
			}) => void;
		};
		options.onDrop({
			source: { data: { type: 'desktop-layout-pane', pane: 'main' } },
			self: {
				data: { type: 'desktop-layout-pane', pane: 'chat-list', closestEdge: 'top' },
			},
		});

		expect(onDrop).toHaveBeenCalledWith('main', 'chat-list', 'top');
	});
});
