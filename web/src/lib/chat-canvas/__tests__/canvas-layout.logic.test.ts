import { describe, expect, it } from 'vitest';
import {
	availablePosition,
	boxBounds,
	finishNodeMove,
	moveChat,
	nodePosition,
	removeCanvasElements,
} from '../canvas-layout';
import { canvasContent } from './canvas-fixtures';

describe('canvas layout and membership', () => {
	it('stacks cards predictably and sizes their parent from membership', () => {
		const content = canvasContent();
		const box = content.nodes[0];
		if (box.type !== 'box') throw new Error('Expected box');
		expect(nodePosition(content, content.nodes[2])).toEqual({ x: 16, y: 52 });
		expect(nodePosition(content, content.nodes[3])).toEqual({ x: 16, y: 196 });
		expect(boxBounds(content, box)).toMatchObject({ width: 332, height: 344 });
	});

	it('moves a box and its children without altering their membership or order', () => {
		const original = canvasContent();
		const moved = finishNodeMove(
			original,
			new Map([
				['box-a', { x: -800, y: 900 }],
				['chat-a', { x: -784, y: 952 }],
			]),
		);
		expect(nodePosition(moved, moved.nodes[2])).toEqual({ x: -784, y: 952 });
		expect(moved.nodes[2]).toEqual(original.nodes[2]);
		expect(original.nodes[0].position).toEqual({ x: 0, y: 0 });
	});

	it('reparents dropped cards and detaches cards dropped outside all boxes', () => {
		const moved = finishNodeMove(canvasContent(), new Map([['chat-a', { x: 516, y: 52 }]]));
		expect(moved.nodes.find((node) => node.id === 'chat-a')).toMatchObject({
			boxId: 'box-b',
			position: { x: 0, y: 0 },
		});
		const detached = finishNodeMove(moved, new Map([['chat-a', { x: -500, y: -500 }]]));
		expect(detached.nodes.find((node) => node.id === 'chat-a')).toMatchObject({
			boxId: null,
			position: { x: -500, y: -500 },
		});
	});

	it('reorders grouped selections atomically regardless of position map order', () => {
		const content = canvasContent();
		content.nodes.push({
			id: 'chat-c',
			type: 'chat',
			chatId: '1780000000000003',
			boxId: 'box-a',
			position: { x: 0, y: 0 },
		});
		const positions = new Map([
			['chat-a', { x: 16, y: 196 }],
			['chat-b', { x: 16, y: 340 }],
		]);
		const moved = finishNodeMove(content, positions);
		expect(moved).toEqual(finishNodeMove(content, new Map([...positions].reverse())));
		expect(moved.nodes.filter((node) => node.type === 'chat').map((node) => node.id)).toEqual([
			'chat-c',
			'chat-a',
			'chat-b',
		]);
	});

	it('uses original destination bounds for every card in a cross-box selection', () => {
		const content = canvasContent();
		const positions = new Map([
			['chat-a', { x: 516, y: 52 }],
			['chat-b', { x: 516, y: 80 }],
		]);
		const moved = finishNodeMove(content, positions);
		expect(moved).toEqual(finishNodeMove(content, new Map([...positions].reverse())));
		expect(moved.nodes.filter((node) => node.type === 'chat')).toMatchObject([
			{ id: 'chat-a', boxId: 'box-b' },
			{ id: 'chat-b', boxId: 'box-b' },
		]);
	});

	it('keeps canonical content unchanged for within-slot grouped movement', () => {
		const content = canvasContent();
		expect(
			finishNodeMove(
				content,
				new Map([
					['chat-a', { x: 22, y: 60 }],
					['chat-b', { x: 22, y: 200 }],
				]),
			),
		).toEqual(content);
	});

	it('orders a chat inside a box without duplicating it', () => {
		const moved = moveChat(canvasContent(), 'chat-b', 'box-a', { x: 0, y: 0 }, 0);
		expect(moved.nodes.filter((node) => node.type === 'chat').map((node) => node.id)).toEqual([
			'chat-b',
			'chat-a',
		]);
	});

	it('releases box contents in place and removes only affected connections', () => {
		const original = canvasContent();
		const removed = removeCanvasElements(original, new Set(['box-a']));
		expect(removed.connections).toEqual([]);
		expect(removed.nodes.find((node) => node.id === 'chat-a')).toMatchObject({
			boxId: null,
			position: { x: 16, y: 52 },
		});
		expect(removed.nodes).toHaveLength(3);
	});
	it('places new elements beyond occupied boxes without moving existing work', () => {
		const content = canvasContent();
		expect(availablePosition(content, { x: 0, y: 0 })).toEqual({ x: 856, y: 0 });
		expect(availablePosition(content, { x: -500, y: -500 })).toEqual({ x: -500, y: -500 });
	});
});
