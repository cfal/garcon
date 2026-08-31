import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	installResizeObserverHarness,
	ResizeObserverHarness,
} from '$lib/components/shared/__tests__/resize-observer-harness';
import { VirtualListGeometry } from '$lib/virt/virtual-list-geometry.js';
import type {
	VirtualListSnapshot,
	VirtualTransactionRecord,
} from '$lib/virt/virtual-list-types.js';
import { ConversationFeedVirtualController } from '../ConversationFeedVirtualController.svelte.js';
import { isConversationTargetLayoutReady } from '../conversation-feed-viewport-geometry.js';
import {
	captureConversationVirtualAnchor,
	ConversationEarlierPrependAnchorOwnership,
	ConversationMountedVirtualItems,
} from '../conversation-feed-virtual-runtime.js';
import ConversationFeedVirtualControllerTestHost from './ConversationFeedVirtualControllerTestHost.svelte';

interface ControllerExposure {
	controller: ConversationFeedVirtualController;
	transactions: readonly VirtualTransactionRecord[];
	viewport(): HTMLDivElement | null;
	initialEndRestoredCount(): number;
	appendItem(): Promise<void>;
	prependItems(): Promise<void>;
	prependDuring(activity: 'dragging' | 'coasting'): Promise<void>;
	replaceSurface(): Promise<void>;
	setPinned(value: boolean): Promise<void>;
	resetMeasurements(): Promise<void>;
	hide(): Promise<void>;
	showAtLayout(viewportWidth: number, itemSize: number): Promise<void>;
}

function nextFrame(): Promise<void> {
	return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function settleController(): Promise<void> {
	await Promise.resolve();
	await nextFrame();
	await Promise.resolve();
}

async function renderController(options?: { invalidInitialGeometry?: boolean }): Promise<{
	exposure: ControllerExposure;
	unmount(): void;
}> {
	let exposure: ControllerExposure | undefined;
	const rendered = render(ConversationFeedVirtualControllerTestHost, {
		...options,
		onReady(value) {
			exposure = value;
		},
	});
	await waitFor(() => expect(exposure).toBeDefined());
	await settleController();
	if (!exposure) throw new Error('Expected the virtual controller exposure');
	return { exposure, unmount: rendered.unmount };
}

function snapshot(keys: readonly string[], sizes: readonly number[]): VirtualListSnapshot {
	const geometry = new VirtualListGeometry();
	geometry.setItems(keys, sizes);
	return {
		revision: geometry.revision,
		visibleRange: geometry.range(0, 100),
		overscanRange: geometry.range(0, 100),
		sizerSize: geometry.totalSize(),
		positions: geometry.positionView(),
	};
}

describe('ConversationFeed virtual policy', () => {
	it('captures the first eligible painted row and stable fallback keys', () => {
		const current = snapshot(['spacer', 'a', 'b', 'c'], [20, 40, 40, 40]);
		const anchor = captureConversationVirtualAnchor({
			snapshot: current,
			position: {
				paintedOffset: 65,
				logicalOffset: 65,
				distanceFromStart: 65,
				leadingContentReachable: true,
			},
			keys: ['spacer', 'a', 'b', 'c'],
			transcriptKeys: new Set(['a', 'b', 'c']),
			preferTranscript: true,
		});

		expect(anchor).toEqual({
			key: 'b',
			viewportOffset: -5,
			fallbackKeys: ['a', 'c', 'spacer'],
		});
	});

	it('retains mounted rows and treats unreachable leading content as clamped', () => {
		const ownership = new ConversationEarlierPrependAnchorOwnership();
		const anchor = { key: 'b', viewportOffset: 4, fallbackKeys: [] };
		ownership.beginMountedRowRetention(['a', 'b']);
		ownership.carry(anchor, true);

		expect(
			ownership.retainedIndexes(
				[3],
				new Map([
					['a', 5],
					['b', 6],
				]),
			),
		).toEqual([3, 5, 6]);
		expect(
			ownership.preserves('earlier', {
				distanceFromStart: 80,
				leadingContentReachable: false,
			}),
		).toBe(true);
		expect(
			ownership.preserves('later', {
				distanceFromStart: 0,
				leadingContentReachable: true,
			}),
		).toBe(false);
	});

	it('blocks an active clamped scrollbar prepend until the drag ends', () => {
		const ownership = new ConversationEarlierPrependAnchorOwnership();
		ownership.beginMountedRowRetention([], true, true);

		expect(ownership.preserves(null, null, 'scrollbar-drag')).toBe(true);
		expect(ownership.blocksViewportMutation('scrollbar-drag')).toBe(true);
		ownership.finishScrollbarDrag();
		expect(ownership.blocksViewportMutation('scrollbar-drag')).toBe(false);
	});

	it('ignores disconnected or stale mounted row identities', () => {
		const mounted = new ConversationMountedVirtualItems();
		const current = document.createElement('div');
		current.dataset.index = '1';
		current.dataset.chatVirtualItem = 'b';
		document.body.append(current);
		const stale = document.createElement('div');
		stale.dataset.index = '1';
		stale.dataset.chatVirtualItem = 'a';
		document.body.append(stale);
		mounted.add(current);
		mounted.add(stale);

		expect(mounted.transcriptKeys(['a', 'b'], new Set(['a', 'b']))).toEqual(new Set(['b']));
		current.remove();
		expect(mounted.transcriptKeys(['a', 'b'], new Set(['a', 'b']))).toEqual(new Set());
		stale.remove();
	});

	it('captures the first actually painted row instead of an overscan estimate', () => {
		const mounted = new ConversationMountedVirtualItems();
		const viewport = document.createElement('div');
		const overscan = document.createElement('div');
		const visible = document.createElement('div');
		overscan.dataset.index = '0';
		overscan.dataset.chatVirtualItem = 'overscan';
		visible.dataset.index = '1';
		visible.dataset.chatVirtualItem = 'visible';
		document.body.append(viewport, overscan, visible);
		vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 100));
		vi.spyOn(overscan, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, -40, 100, 20));
		vi.spyOn(visible, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, -3, 100, 20));
		mounted.add(overscan);
		mounted.add(visible);

		expect(
			mounted.visibleAnchor({
				viewport,
				configuredKeys: ['overscan', 'visible'],
				eligibleKeys: new Set(['overscan', 'visible']),
			}),
		).toEqual({ key: 'visible', viewportOffset: -3, fallbackKeys: ['overscan'] });
		viewport.remove();
		overscan.remove();
		visible.remove();
	});

	it('waits for explicitly pending target content', () => {
		const target = document.createElement('div');
		target.dataset.chatLayoutPending = 'true';
		expect(isConversationTargetLayoutReady(target)).toBe(false);
		delete target.dataset.chatLayoutPending;
		expect(isConversationTargetLayoutReady(target)).toBe(true);
	});
});

describe('ConversationFeedVirtualController', () => {
	let restoreResizeObserver: () => void;

	beforeEach(() => {
		restoreResizeObserver = installResizeObserverHarness();
	});

	afterEach(() => {
		cleanup();
		restoreResizeObserver();
	});

	it('attaches one observer to the viewport and items, never the sizer', async () => {
		const { exposure } = await renderController();
		const viewport = exposure.viewport();
		const sizer = document.querySelector<HTMLElement>('[data-controller-sizer]');
		const observer = ResizeObserverHarness.instances[0];

		expect(viewport).not.toBeNull();
		expect(sizer).not.toBeNull();
		expect(observer?.observed.has(viewport!)).toBe(true);
		expect(observer?.observed.has(sizer!)).toBe(false);
		expect(exposure.controller.snapshot.positions.count).toBe(12);
		expect(exposure.controller.isReady()).toBe(true);
		expect(exposure.transactions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ source: 'replace-surface', scrollWrites: 0 }),
				expect.objectContaining({ source: 'resume', provenance: 'navigation' }),
			]),
		);
	});

	it('captures provider-neutral end and row restoration targets', async () => {
		const { exposure } = await renderController();
		expect(exposure.controller.captureRestoreTarget('view-1', true)).toEqual({ kind: 'end' });

		await exposure.setPinned(false);
		await settleController();
		const target = exposure.controller.captureRestoreTarget('view-1', false);

		expect(target).toEqual(
			expect.objectContaining({
				kind: 'row',
				transcriptViewId: 'view-1',
				ordinal: expect.any(Number),
				viewportOffset: expect.any(Number),
			}),
		);
	});

	it('retries an initially rejected geometry publication', async () => {
		const { exposure } = await renderController({ invalidInitialGeometry: true });

		expect(exposure.transactions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ source: 'items', rejectionReason: 'length-mismatch' }),
			]),
		);
		expect(exposure.controller.snapshot.positions.count).toBe(12);
	});

	it('publishes pinned appends as follow transactions', async () => {
		const { exposure } = await renderController();
		const before = exposure.transactions.length;

		await exposure.appendItem();
		await settleController();
		const records = exposure.transactions.slice(before);

		expect(records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ source: 'items', provenance: 'follow', anchorKind: 'end' }),
			]),
		);
		expect(exposure.controller.snapshot.positions.count).toBe(13);
	});

	it('anchors a prepend to committed content when scrolling outruns the rendered range', async () => {
		const { exposure } = await renderController();
		await exposure.setPinned(false);
		const viewport = exposure.viewport();
		if (!viewport) throw new Error('Expected the virtual viewport to be mounted');
		const mountedIndexes = [...document.querySelectorAll<HTMLElement>('[data-chat-virtual-item]')]
			.map((element) => Number(element.dataset.index))
			.filter(Number.isInteger)
			.sort((left, right) => left - right);
		const firstMountedIndex = mountedIndexes[0];
		const preceding = exposure.controller.snapshot.positions.itemAt(firstMountedIndex - 1);
		if (!preceding) throw new Error('Expected an unmounted row before the rendered range');
		viewport.scrollTop = preceding.start + 1;
		const before = exposure.transactions.length;

		await exposure.prependItems();
		await settleController();
		const itemsTransaction = exposure.transactions
			.slice(before)
			.find((candidate) => candidate.source === 'items');

		expect(itemsTransaction).toMatchObject({
			anchorKind: 'item',
			anchorIndex: firstMountedIndex,
		});
	});

	it.each(['dragging', 'coasting'] as const)(
		'defers prepend correction without a physical write while %s',
		async (activity) => {
			const { exposure } = await renderController();
			const before = exposure.transactions.length;

			await exposure.prependDuring(activity);
			await settleController();
			const record = exposure.transactions
				.slice(before)
				.find((candidate) => candidate.source === 'items');

			expect(record).toMatchObject({
				activity,
				provenance: 'follow',
				scrollWrites: 0,
			});
			expect(record?.deviationAfter).toBeGreaterThan(0);
			expect(exposure.controller.viewportPosition()?.leadingContentReachable).toBe(false);
		},
	);

	it('settles a deferred pinned correction after native activity becomes idle', async () => {
		const { exposure } = await renderController();
		await exposure.prependDuring('coasting');
		const viewport = exposure.viewport();
		if (!viewport) throw new Error('Expected the virtual viewport to be mounted');
		viewport.scrollTop = 0;
		await settleController();
		const before = exposure.transactions.length;

		exposure.controller.setNativeScrollActivity('idle');
		await settleController();
		await waitFor(() =>
			expect(
				exposure.transactions.slice(before).some((candidate) => candidate.scrollWrites > 0),
			).toBe(true),
		);
		const redemption = exposure.transactions
			.slice(before)
			.find((candidate) => candidate.scrollWrites > 0);
		expect(redemption).toMatchObject({
			source: 'programmatic',
			provenance: 'navigation',
			scrollWrites: 1,
			deviationAfter: 0,
		});
		expect(exposure.controller.viewportPosition()?.leadingContentReachable).toBe(true);
	});

	it('defers pinned end requests until native coasting becomes idle', async () => {
		const { exposure } = await renderController();
		const viewport = exposure.viewport();
		if (!viewport) throw new Error('Expected the virtual viewport to be mounted');
		viewport.scrollTop = Math.max(0, viewport.scrollTop - 40);
		exposure.controller.setNativeScrollActivity('coasting');
		const before = exposure.transactions.length;

		exposure.controller.scrollToEnd();
		await settleController();
		expect(exposure.transactions.slice(before).some((record) => record.scrollWrites > 0)).toBe(
			false,
		);

		exposure.controller.setNativeScrollActivity('idle');
		await settleController();
		expect(exposure.transactions.slice(before)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					source: 'programmatic',
					provenance: 'navigation',
					scrollWrites: 1,
				}),
			]),
		);
	});

	it('drops a deferred end request after the user detaches from the end', async () => {
		const { exposure } = await renderController();
		exposure.controller.setNativeScrollActivity('coasting');
		const before = exposure.transactions.length;

		exposure.controller.scrollToEnd();
		await exposure.setPinned(false);
		exposure.controller.setNativeScrollActivity('idle');
		await settleController();

		expect(exposure.transactions.slice(before).some((record) => record.scrollWrites > 0)).toBe(
			false,
		);
	});

	it('replaces a surface through an empty generation and one owned target', async () => {
		const { exposure } = await renderController();
		const before = exposure.transactions.length;

		await exposure.replaceSurface();
		await settleController();
		const records = exposure.transactions.slice(before);

		expect(records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ source: 'replace-surface', scrollWrites: 0 }),
				expect.objectContaining({ source: 'resume', provenance: 'navigation' }),
			]),
		);
		expect(exposure.controller.snapshot.positions.itemAt(0)?.key).toContain('surface-2');
		expect(exposure.controller.viewportPosition()).not.toBeNull();
	});

	it('resets measurements after wholesale estimate changes', async () => {
		const { exposure } = await renderController();
		const initialSize = exposure.controller.snapshot.sizerSize;

		await exposure.resetMeasurements();
		await settleController();
		expect(exposure.controller.snapshot.sizerSize).toBeLessThan(initialSize);
	});

	it('invalidates hidden row measurements when the viewport width changes', async () => {
		const { exposure } = await renderController();
		exposure.controller.scrollToEnd();
		await settleController();

		await exposure.hide();
		await exposure.showAtLayout(240, 80);
		await settleController();

		expect(exposure.controller.isReady()).toBe(true);
		expect(exposure.controller.snapshot.positions.itemAt(11)?.size).toBe(80);
		const viewport = exposure.viewport();
		expect(viewport).not.toBeNull();
		expect(
			Math.abs(
				exposure.controller.snapshot.sizerSize -
					((viewport?.scrollTop ?? 0) + (viewport?.clientHeight ?? 0)),
			),
		).toBeLessThanOrEqual(0.5);
	});

	it('retains hidden row measurements when the viewport width is unchanged', async () => {
		const { exposure } = await renderController();
		exposure.controller.scrollToEnd();
		await settleController();

		await exposure.hide();
		await exposure.showAtLayout(400, 80);
		await settleController();

		expect(exposure.controller.snapshot.positions.itemAt(11)?.size).toBe(40);
		const viewport = exposure.viewport();
		expect(viewport).not.toBeNull();
		expect(
			Math.abs(
				exposure.controller.snapshot.sizerSize -
					((viewport?.scrollTop ?? 0) + (viewport?.clientHeight ?? 0)),
			),
		).toBeLessThanOrEqual(0.5);
	});

	it('preserves a hidden reading anchor when the viewport width changes', async () => {
		const { exposure } = await renderController();
		await exposure.setPinned(false);
		exposure.controller.scrollToStart();
		await settleController();
		exposure.controller.scrollBy(240);
		await settleController();
		const viewport = exposure.viewport();
		const before = exposure.controller.snapshot.positions.itemAt(6);
		if (!viewport || !before) throw new Error('Expected the reading row to be available');
		const viewportOffset = before.start - viewport.scrollTop;

		await exposure.hide();
		await exposure.showAtLayout(240, 80);
		await settleController();

		const after = exposure.controller.snapshot.positions.itemAt(6);
		expect(after?.size).toBe(80);
		expect(Math.abs((after?.start ?? 0) - viewport.scrollTop - viewportOffset)).toBeLessThanOrEqual(
			0.5,
		);
	});

	it('owns every programmatic scroll synchronously and destroys idempotently', async () => {
		const { exposure, unmount } = await renderController();

		exposure.controller.scrollToStart();
		await Promise.resolve();
		expect(exposure.controller.ownsScrollPosition()).toBe(true);
		await settleController();
		expect(exposure.controller.ownsScrollPosition()).toBe(false);

		exposure.controller.destroy();
		exposure.controller.destroy();
		expect(exposure.controller.isReady()).toBe(false);
		unmount();
	});
});
