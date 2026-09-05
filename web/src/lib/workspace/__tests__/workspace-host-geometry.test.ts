import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalWorkspaceSnapshot } from '../canonical-layout';
import type { WorkspaceLayoutSnapshot } from '../surface-types';
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

describe('WorkspaceHostGeometryState', () => {
	let restoreResizeObserver: () => void;
	let frames: Map<number, FrameRequestCallback>;
	let nextFrameId: number;

	beforeEach(() => {
		vi.useFakeTimers();
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
		vi.useRealTimers();
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
		const onResizeSettled = vi.fn().mockResolvedValue(true);
		const geometry = new WorkspaceHostGeometryState({
			getSnapshot: () => currentSnapshot,
			getIsMobile: () => isMobile,
			onResizeSettled,
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
			onResizeSettled,
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
		expect(harness.geometry.size).toBeNull();

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

	it('waits for resizing to settle and retries reserved merges', async () => {
		const harness = createHarness();
		harness.onResizeSettled.mockResolvedValueOnce(false);
		await vi.advanceTimersByTimeAsync(149);
		expect(harness.onResizeSettled).not.toHaveBeenCalled();
		harness.setMeasured(400, 300);
		ResizeObserverHarness.emit(harness.element, 400, 300);
		flushFrames();
		await vi.advanceTimersByTimeAsync(150);
		expect(harness.onResizeSettled).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(150);
		expect(harness.onResizeSettled).toHaveBeenCalledTimes(2);
		harness.detach();
		await vi.advanceTimersByTimeAsync(1000);
		expect(harness.onResizeSettled).toHaveBeenCalledTimes(2);
	});
	it.each(['mobile', 'fullscreen'])('waits for fresh desktop geometry after %s', async (mode) => {
		const snapshot = twoWindowSnapshot();
		const harness = createHarness({
			snapshot:
				mode === 'fullscreen' ? { ...snapshot, fullscreenWindowId: 'window-main' } : snapshot,
			isMobile: mode === 'mobile',
		});
		await vi.advanceTimersByTimeAsync(1000);
		expect(harness.onResizeSettled).not.toHaveBeenCalled();
		harness.setMobile(false);
		harness.setSnapshot(snapshot);
		harness.setMeasured(500, 400);
		harness.geometry.layoutPublished();
		expect(harness.onResizeSettled).not.toHaveBeenCalled();
		flushFrames();
		expect(harness.geometry.size).toEqual({ width: 500, height: 400 });
		await vi.advanceTimersByTimeAsync(150);
		expect(harness.onResizeSettled).toHaveBeenCalledOnce();
		harness.detach();
	});
	it('cancels a settled callback on detach', async () => {
		const harness = createHarness();
		harness.detach();
		await vi.advanceTimersByTimeAsync(1000);
		expect(harness.onResizeSettled).not.toHaveBeenCalled();
	});
});
