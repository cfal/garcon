import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalWorkspaceSnapshot } from '../canonical-layout';
import type { WorkspaceLayoutSnapshot } from '../surface-types';
import { reduceWorkspaceLayout } from '../workspace-layout.svelte';
import { WorkspaceHostGeometryState } from '../workspace-host-geometry.svelte';
import {
	installResizeObserverHarness,
	ResizeObserverHarness,
} from '$lib/components/shared/__tests__/resize-observer-harness';

function domRect(width: number, height: number): DOMRect {
	return {
		x: 0,
		y: 0,
		width,
		height,
		top: 0,
		right: width,
		bottom: height,
		left: 0,
		toJSON: () => ({ width, height }),
	} as DOMRect;
}

function twoWindowSnapshot(): WorkspaceLayoutSnapshot {
	return canonicalWorkspaceSnapshot();
}

function singleWindowSnapshot(): WorkspaceLayoutSnapshot {
	return reduceWorkspaceLayout(twoWindowSnapshot(), [
		{ type: 'remove-surface', surfaceId: 'singleton:files' },
	]);
}

describe('WorkspaceHostGeometryState', () => {
	let restoreResizeObserver: () => void;
	let frames: Map<number, FrameRequestCallback>;
	let nextFrameId: number;

	beforeEach(() => {
		restoreResizeObserver = installResizeObserverHarness();
		frames = new Map();
		nextFrameId = 1;
		vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
			const id = nextFrameId;
			nextFrameId += 1;
			frames.set(id, callback);
			return id;
		});
		vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
	});

	afterEach(() => {
		restoreResizeObserver();
		vi.unstubAllGlobals();
	});

	function flushFrames(): void {
		const queued = [...frames.entries()];
		frames.clear();
		for (const [, callback] of queued) callback(performance.now());
	}

	function createHarness(options?: {
		snapshot?: WorkspaceLayoutSnapshot;
		isMobile?: boolean;
		width?: number;
		height?: number;
	}) {
		let currentSnapshot = options?.snapshot ?? twoWindowSnapshot();
		let isMobile = options?.isMobile ?? false;
		let measured = { width: options?.width ?? 900, height: options?.height ?? 700 };
		const beforeCompactProjection = vi.fn();
		const onCompactProjectionChanged = vi.fn();
		const geometry = new WorkspaceHostGeometryState({
			getSnapshot: () => currentSnapshot,
			getIsMobile: () => isMobile,
			beforeCompactProjection,
			onCompactProjectionChanged,
		});
		const element = document.createElement('div');
		vi.spyOn(element, 'getBoundingClientRect').mockImplementation(() =>
			domRect(measured.width, measured.height),
		);
		const detach = geometry.attach(element);
		if (!detach) throw new Error('Expected host attachment cleanup');
		return {
			geometry,
			element,
			beforeCompactProjection,
			onCompactProjectionChanged,
			detach,
			setSnapshot(snapshot: WorkspaceLayoutSnapshot) {
				currentSnapshot = snapshot;
			},
			setMobile(value: boolean) {
				isMobile = value;
			},
			setMeasured(width: number, height: number) {
				measured = { width, height };
			},
		};
	}

	it('measures synchronously, coalesces observer work, ignores zero, and cleans up', () => {
		const harness = createHarness();
		expect(harness.geometry.size).toEqual({ width: 900, height: 700 });
		expect(ResizeObserverHarness.instances).toHaveLength(1);
		const initialSize = harness.geometry.size;

		ResizeObserverHarness.emit(harness.element, 900, 700);
		flushFrames();
		expect(harness.geometry.size).toBe(initialSize);

		harness.setMeasured(0, 0);
		ResizeObserverHarness.emit(harness.element, 0, 0);
		flushFrames();
		expect(harness.geometry.size).toBe(initialSize);

		harness.setMeasured(840, 650);
		ResizeObserverHarness.emit(harness.element, 840, 650);
		harness.setMeasured(820, 640);
		ResizeObserverHarness.emit(harness.element, 820, 640);
		expect(frames.size).toBe(1);
		flushFrames();
		expect(harness.geometry.size).toEqual({ width: 820, height: 640 });

		harness.setMeasured(700, 600);
		ResizeObserverHarness.emit(harness.element, 700, 600);
		expect(frames.size).toBe(1);
		harness.detach();
		expect(frames.size).toBe(0);
		expect(harness.geometry.size).toBeNull();
		expect(ResizeObserverHarness.instances[0]?.observed.size).toBe(0);
	});

	it('enters compact once and reconciles layout changes without observer churn', () => {
		const harness = createHarness({ width: 470, height: 700 });
		expect(harness.geometry.compactActive).toBe(true);
		expect(harness.geometry.compactSession).toBe(1);
		expect(harness.beforeCompactProjection).toHaveBeenCalledTimes(1);
		expect(harness.onCompactProjectionChanged.mock.calls).toEqual([[true]]);

		harness.geometry.layoutPublished(twoWindowSnapshot());
		expect(ResizeObserverHarness.instances).toHaveLength(1);
		expect(harness.geometry.compactSession).toBe(1);
		expect(harness.onCompactProjectionChanged).toHaveBeenCalledTimes(1);

		const singleWindow = singleWindowSnapshot();
		harness.setSnapshot(singleWindow);
		harness.geometry.layoutPublished(singleWindow);
		expect(harness.geometry.compactActive).toBe(false);
		expect(harness.geometry.compactSession).toBe(1);
		expect(harness.onCompactProjectionChanged.mock.calls).toEqual([[true], [false]]);
		harness.detach();
	});

	it('retains the compact latch while mobile without recreating the attachment', () => {
		const harness = createHarness({ width: 470, height: 700 });
		harness.setMobile(true);
		harness.geometry.layoutPublished(twoWindowSnapshot());
		expect(harness.geometry.compactActive).toBe(false);
		expect(harness.geometry.compactSession).toBe(1);
		expect(harness.onCompactProjectionChanged.mock.calls).toEqual([[true]]);

		harness.setMobile(false);
		harness.geometry.layoutPublished(twoWindowSnapshot());
		expect(harness.geometry.singleWindowProjectionActive).toBe(true);
		flushFrames();
		expect(harness.geometry.compactActive).toBe(true);
		expect(harness.geometry.compactSession).toBe(1);
		expect(ResizeObserverHarness.instances).toHaveLength(1);
		expect(harness.onCompactProjectionChanged.mock.calls).toEqual([[true]]);
		harness.detach();
	});

	it('holds one window until fullscreen exit is measured against the tiled host', () => {
		const tiled = twoWindowSnapshot();
		const fullscreen = { ...tiled, fullscreenWindowId: 'window-main' as const };
		const harness = createHarness({ snapshot: tiled, width: 900, height: 700 });

		harness.setSnapshot(fullscreen);
		harness.geometry.layoutPublished(fullscreen);
		harness.setMeasured(1200, 700);
		ResizeObserverHarness.emit(harness.element, 1200, 700);
		flushFrames();
		expect(harness.geometry.compactActive).toBe(false);

		harness.setSnapshot(tiled);
		harness.setMeasured(900, 700);
		harness.geometry.layoutPublished(tiled);
		expect(harness.geometry.singleWindowProjectionActive).toBe(true);
		expect(harness.geometry.compactActive).toBe(false);
		expect(harness.onCompactProjectionChanged).not.toHaveBeenCalled();
		flushFrames();
		expect(harness.geometry.singleWindowProjectionActive).toBe(false);
		expect(harness.beforeCompactProjection).toHaveBeenCalledTimes(1);
		expect(harness.onCompactProjectionChanged).not.toHaveBeenCalled();
		harness.detach();
	});

	it('cancels once when a post-fullscreen safety hold resolves to compact', () => {
		const tiled = twoWindowSnapshot();
		const fullscreen = { ...tiled, fullscreenWindowId: 'window-main' as const };
		const harness = createHarness({ snapshot: fullscreen, width: 470, height: 700 });

		harness.setSnapshot(tiled);
		harness.geometry.layoutPublished(tiled);
		expect(harness.geometry.singleWindowProjectionActive).toBe(true);
		expect(harness.beforeCompactProjection).toHaveBeenCalledTimes(1);
		expect(harness.onCompactProjectionChanged).not.toHaveBeenCalled();
		flushFrames();
		expect(harness.geometry.compactActive).toBe(true);
		expect(harness.geometry.compactSession).toBe(1);
		expect(harness.beforeCompactProjection).toHaveBeenCalledTimes(1);
		expect(harness.onCompactProjectionChanged.mock.calls).toEqual([[true]]);
		harness.detach();
	});

	it('waits for the desktop host measurement after returning from mobile', () => {
		const harness = createHarness({ isMobile: true, width: 470, height: 700 });
		expect(harness.geometry.compactActive).toBe(false);
		harness.setMobile(false);
		harness.setMeasured(900, 700);
		harness.geometry.layoutPublished(twoWindowSnapshot());
		expect(harness.geometry.singleWindowProjectionActive).toBe(true);
		flushFrames();
		expect(harness.geometry.singleWindowProjectionActive).toBe(false);
		expect(harness.geometry.compactActive).toBe(false);
		harness.detach();
	});
});
