import { describe, expect, it } from 'vitest';
import {
	dragLeftContainer,
	resolveDropZone,
	resolvePaneDropTarget,
	splitDropBlockedReason,
	splitDropResultPresentation,
	SPLIT_DROP_ZONES,
	type ActiveSplitDropTarget,
} from '../split-drop-controller.svelte';
import * as m from '$lib/paraglide/messages.js';

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

describe('resolvePaneDropTarget', () => {
	const panes = [
		{ paneId: 'pane-1', rect: { left: 0, top: 0, width: 400, height: 300 } },
		{ paneId: 'pane-2', rect: { left: 400, top: 0, width: 400, height: 300 } },
	];

	it('targets the pane under the pointer with its edge zone for sidebar drags', () => {
		const resolved = resolvePaneDropTarget(panes, 410, 150, null);
		expect(resolved?.paneId).toBe('pane-2');
		expect(resolved?.zone).toBe('left');
		expect(resolved?.rect).toBe(panes[1].rect);
	});

	it('falls back to the nearest pane for sidebar drags outside every pane', () => {
		const resolved = resolvePaneDropTarget(panes, 100, 400, null);
		expect(resolved?.paneId).toBe('pane-1');
		expect(resolved?.zone).toBe('bottom');
	});

	it('targets the whole pane for pane-origin drags regardless of the pointer band', () => {
		const resolved = resolvePaneDropTarget(panes, 410, 10, 'pane-1');
		expect(resolved?.paneId).toBe('pane-2');
		expect(resolved?.zone).toBe('center');
	});

	it('offers no target over the dragged pane itself', () => {
		expect(resolvePaneDropTarget(panes, 200, 150, 'pane-1')).toBeNull();
	});

	it('excludes the dragged pane from the nearest-pane fallback', () => {
		const resolved = resolvePaneDropTarget(panes, 100, 400, 'pane-1');
		expect(resolved?.paneId).toBe('pane-2');
		expect(resolved?.zone).toBe('center');
	});
});

describe('splitDropBlockedReason', () => {
	it('blocks sidebar drags onto edge zones once the pane limit is reached', () => {
		expect(
			splitDropBlockedReason({
				isPaneSwap: false,
				isExistingSidebarChat: false,
				zone: 'left',
				paneCount: 4,
			}),
		).toBe('max-panes');
	});

	it('never blocks pane swaps, which do not add a pane', () => {
		expect(
			splitDropBlockedReason({
				isPaneSwap: true,
				isExistingSidebarChat: false,
				zone: 'left',
				paneCount: 4,
			}),
		).toBeUndefined();
	});

	it('allows center drops and already-open chats at the pane limit', () => {
		expect(
			splitDropBlockedReason({
				isPaneSwap: false,
				isExistingSidebarChat: false,
				zone: 'center',
				paneCount: 4,
			}),
		).toBeUndefined();
		expect(
			splitDropBlockedReason({
				isPaneSwap: false,
				isExistingSidebarChat: true,
				zone: 'left',
				paneCount: 4,
			}),
		).toBeUndefined();
	});

	it('allows edge zones below the pane limit', () => {
		expect(
			splitDropBlockedReason({
				isPaneSwap: false,
				isExistingSidebarChat: false,
				zone: 'left',
				paneCount: 3,
			}),
		).toBeUndefined();
	});
});

describe('splitDropResultPresentation', () => {
	function makeTarget(overrides: Partial<ActiveSplitDropTarget>): ActiveSplitDropTarget {
		return {
			paneId: 'pane-1',
			zone: 'center',
			rect: { left: 0, top: 0, width: 400, height: 300 },
			...overrides,
		};
	}

	it('presents blocked targets before any other reason', () => {
		const presentation = splitDropResultPresentation(
			makeTarget({ blockedReason: 'max-panes', swapReason: 'pane-swap' }),
		);
		expect(presentation.label).toBe(m.workspace_drop_zone_max_panes());
		expect(presentation.toneClass).toContain('border-destructive/50');
		expect(presentation.labelClass).toContain('text-destructive');
	});

	it('presents pane swaps before the already-open focus reason', () => {
		const presentation = splitDropResultPresentation(makeTarget({ swapReason: 'pane-swap' }));
		expect(presentation.label).toBe(m.workspace_drop_zone_swap());
		expect(presentation.toneClass).toContain('border-accent/50');
		expect(presentation.labelClass).toContain('text-accent-foreground');
	});

	it('presents already-open sidebar chats with the accent tone', () => {
		const presentation = splitDropResultPresentation(makeTarget({ focusReason: 'already-open' }));
		expect(presentation.label).toBe(m.workspace_drop_zone_already_open());
		expect(presentation.toneClass).toContain('border-accent/50');
	});

	it('presents the hovered zone label for plain sidebar drags', () => {
		const left = splitDropResultPresentation(makeTarget({ zone: 'left' }));
		expect(left.label).toBe(m.workspace_drop_zone_left());
		expect(left.toneClass).toContain('border-primary/50');
		expect(left.labelClass).toContain('text-primary');

		const center = splitDropResultPresentation(makeTarget({ zone: 'center' }));
		expect(center.label).toBe(m.workspace_drop_zone_replace());
		expect(center.toneClass).toContain('border-accent/50');
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
