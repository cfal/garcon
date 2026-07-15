import { describe, expect, it } from 'vitest';
import {
	dragLeftContainer,
	resolveDropZone,
	SPLIT_DROP_ZONES,
} from '../split-drop-controller.svelte';

const rect = {
	left: 100,
	top: 200,
	width: 400,
	height: 300,
};

describe('resolveDropZone', () => {
	it('maps pointer positions near each edge to a split zone', () => {
		expect(resolveDropZone(rect, 300, 210)).toBe('top');
		expect(resolveDropZone(rect, 300, 490)).toBe('bottom');
		expect(resolveDropZone(rect, 110, 350)).toBe('left');
		expect(resolveDropZone(rect, 490, 350)).toBe('right');
	});

	it('uses center for positions outside the edge bands', () => {
		expect(resolveDropZone(rect, 300, 350)).toBe('center');
	});
});

describe('dragLeftContainer', () => {
	function makeDragLeave(currentTarget: Element, relatedTarget: Element | null): DragEvent {
		return { currentTarget, relatedTarget } as unknown as DragEvent;
	}

	it('reports still inside when moving onto a child element', () => {
		const container = document.createElement('div');
		const child = document.createElement('span');
		container.appendChild(child);

		expect(dragLeftContainer(makeDragLeave(container, child))).toBe(false);
	});

	it('reports left when moving to an unrelated element or outside the window', () => {
		const container = document.createElement('div');
		const outside = document.createElement('div');

		expect(dragLeftContainer(makeDragLeave(container, outside))).toBe(true);
		expect(dragLeftContainer(makeDragLeave(container, null))).toBe(true);
	});
});

describe('SPLIT_DROP_ZONES', () => {
	it('defines one presentation entry per drop zone', () => {
		expect(SPLIT_DROP_ZONES.map((entry) => entry.zone)).toEqual([
			'top',
			'bottom',
			'left',
			'right',
			'center',
		]);
	});
});
