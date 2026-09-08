import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	ConnectionMode,
	Position,
	XYDrag,
	XYHandle,
	infiniteExtent,
	registerInteractionAbort,
	type InternalNodeBase,
} from '@xyflow/system';

afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

function dragListener(target: EventTarget, type: string) {
	const listeners = (
		target as EventTarget & { __on?: { name: string; type: string; value: EventListener }[] }
	).__on;
	return listeners?.find((listener) => listener.name === 'drag' && listener.type === type)?.value;
}

function internalNode(id: string, x: number): InternalNodeBase {
	const node = { id, position: { x, y: 0 }, data: {} };
	return {
		...node,
		measured: { width: 100, height: 100 },
		internals: {
			positionAbsolute: node.position,
			z: 0,
			userNode: node,
			handleBounds: {
				source: [
					{
						id: 'out',
						nodeId: id,
						type: 'source',
						position: Position.Right,
						x: 95,
						y: 45,
						width: 10,
						height: 10,
					},
				],
				target: [
					{
						id: 'in',
						nodeId: id,
						type: 'target',
						position: Position.Left,
						x: -5,
						y: 45,
						width: 10,
						height: 10,
					},
				],
			},
		},
	};
}

describe('patched Canvas provider lifecycle', () => {
	it('releases the new D3 transport when a prior interaction abort throws', () => {
		const host = document.createElement('div');
		const source = document.createElement('div');
		host.append(source);
		document.body.append(host);
		const node = internalNode('a', 0);
		const started = vi.fn();
		const stopped = vi.fn();
		const drag = XYDrag({
			getStoreItems: () => ({
				nodes: [node],
				edges: [],
				nodeLookup: new Map([[node.id, node]]),
				nodeExtent: infiniteExtent,
				snapGrid: [1, 1],
				snapToGrid: false,
				nodeOrigin: [0, 0],
				multiSelectionActive: false,
				domNode: host,
				transform: [0, 0, 1],
				autoPanOnNodeDrag: false,
				nodesDraggable: true,
				selectNodesOnDrag: false,
				nodeDragThreshold: 0,
				panBy: async () => false,
				unselectNodesAndEdges: () => {},
				updateNodePositions: () => {},
			}),
			onDragStart: started,
			onDragStop: stopped,
		});
		drag.update({ domNode: source, nodeId: node.id });
		registerInteractionAbort(host, () => {
			throw new Error('Previous cancellation failed');
		});
		const start = dragListener(source, 'mousedown')!;
		const down = new MouseEvent('mousedown', { view: window, clientX: 20, clientY: 20 });
		try {
			expect(() => start.call(source, down)).toThrow(AggregateError);
			expect(dragListener(window, 'mousemove')).toBeUndefined();
			expect(dragListener(window, 'mouseup')).toBeUndefined();
			expect(dragListener(window, 'dragstart')).toBeUndefined();
			expect(started).not.toHaveBeenCalled();
			start.call(source, down);
			expect(started).toHaveBeenCalledTimes(1);
			window.dispatchEvent(new MouseEvent('mouseup', { view: window }));
			expect(stopped).toHaveBeenCalledTimes(1);
		} finally {
			drag.destroy();
		}
	});

	it.each([
		{ pointer: 'mouse', removed: 'node' },
		{ pointer: 'mouse', removed: 'handle' },
		{ pointer: 'touch', removed: null },
		{ pointer: 'touch', removed: 'node' },
		{ pointer: 'touch', removed: 'handle' },
	] as const)(
		'completes $pointer connections with removed target $removed',
		({ pointer, removed }) => {
			const host = document.createElement('div');
			const source = document.createElement('div');
			const target = document.createElement('div');
			source.className = 'svelte-flow__handle source connectable connectableend';
			target.className = 'svelte-flow__handle target connectable connectableend';
			target.dataset.nodeid = 'b';
			target.dataset.handleid = 'in';
			target.dataset.id = 'flow-b-in-target';
			host.append(source, target);
			document.body.append(host);
			vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600));
			vi.spyOn(document, 'elementFromPoint').mockReturnValue(target);
			const from = internalNode('a', 0);
			const to = internalNode('b', 300);
			const lookup = new Map([
				[from.id, from],
				[to.id, to],
			]);
			const connect = vi.fn();
			const end = vi.fn();
			const reconnectEnd = vi.fn();
			const update = vi.fn();
			const addListener = vi.spyOn(document, 'addEventListener');
			const removeListener = vi.spyOn(document, 'removeEventListener');
			const reset = vi.fn();
			const touch = (type: string, x: number, ended = false) => {
				const contact = new Touch({ identifier: 1, target: source, clientX: x, clientY: 50 });
				return new TouchEvent(type, { touches: ended ? [] : [contact], changedTouches: [contact] });
			};
			const down =
				pointer === 'touch'
					? touch('touchstart', 100)
					: new MouseEvent('mousedown', { clientX: 100, clientY: 50 });
			source.dispatchEvent(down);
			const cancel = XYHandle.onPointerDown(down, {
				connectionMode: ConnectionMode.Strict,
				connectionRadius: 20,
				handleId: 'out',
				nodeId: from.id,
				edgeUpdaterType: 'source',
				isTarget: false,
				domNode: host,
				nodeLookup: lookup,
				lib: 'svelte',
				flowId: 'flow',
				autoPanOnConnect: false,
				panBy: async () => false,
				cancelConnection: reset,
				onConnect: connect,
				onConnectEnd: end,
				onReconnectEnd: reconnectEnd,
				updateConnection: update,
				getTransform: () => [0, 0, 1],
				getFromHandle: () => from.internals.handleBounds!.source![0],
				handleDomNode: source,
			});
			try {
				document.dispatchEvent(
					pointer === 'touch'
						? touch('touchmove', 300)
						: new MouseEvent('mousemove', { clientX: 300, clientY: 50 }),
				);
				expect(update).toHaveBeenLastCalledWith(
					expect.objectContaining({ isValid: true, toNode: to }),
				);
				if (removed === 'node') lookup.delete(to.id);
				else if (removed === 'handle') to.internals.handleBounds!.target = [];
				document.dispatchEvent(
					pointer === 'touch'
						? touch('touchend', 300, true)
						: new MouseEvent('mouseup', { clientX: 300, clientY: 50 }),
				);
				expect(reset).toHaveBeenCalledTimes(1);
				for (const [type, listener] of addListener.mock.calls) {
					expect(removeListener).toHaveBeenCalledWith(type, listener);
				}
				if (removed) expect(connect).not.toHaveBeenCalled();
				else {
					expect(connect).toHaveBeenCalledExactlyOnceWith({
						source: 'a',
						sourceHandle: 'out',
						target: 'b',
						targetHandle: 'in',
					});
				}
				for (const callback of [end, reconnectEnd]) {
					expect(callback).toHaveBeenCalledTimes(1);
					expect(callback).toHaveBeenLastCalledWith(
						expect.anything(),
						expect.objectContaining({
							isValid: !removed,
							toHandle: removed ? null : expect.objectContaining({ nodeId: 'b', id: 'in' }),
							toNode: removed ? null : to,
							toPosition: removed ? null : Position.Left,
						}),
					);
				}
			} finally {
				cancel();
			}
		},
	);
});
