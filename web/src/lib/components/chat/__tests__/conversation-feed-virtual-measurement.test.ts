import { waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import {
	ConversationVirtualMeasurementManager,
	type ConversationVirtualMeasurementPort,
	observeConversationItemLayoutSettlement,
} from '../conversation-feed-virtual-measurement';

function createRow(index: number, height: number, operationOrder: string[] = []): HTMLDivElement {
	const element = document.createElement('div');
	element.dataset.index = String(index);
	element.dataset.chatVirtualItem = `row-${index}`;
	Object.defineProperty(element, 'offsetHeight', {
		configurable: true,
		get: () => {
			operationOrder.push(`read:${index}`);
			return height;
		},
	});
	document.body.append(element);
	return element;
}

function createMeasurementPort(
	count: number,
	operationOrder: string[] = [],
	itemSizeCache = new Map<string, number>(),
): ConversationVirtualMeasurementPort {
	return {
		indexFromElement: (element) => Number(element.dataset.index),
		isScrolling: true,
		itemSizeCache,
		measure: vi.fn(),
		measureElement: vi.fn(),
		options: {
			count,
			estimateSize: () => 96,
			getItemKey: (index) => `row-${index}`,
		},
		resizeItem: vi.fn((index: number, size: number) => {
			operationOrder.push(`write:${index}`);
			itemSizeCache.set(`row-${index}`, size);
		}),
		scrollDirection: 'backward',
	};
}

describe('ConversationVirtualMeasurementManager', () => {
	it('batches uncached row reads before virtualizer writes in the mount microtask', async () => {
		const manager = new ConversationVirtualMeasurementManager(
			() => 'coasting',
			() => false,
		);
		const operationOrder: string[] = [];
		const elements = [createRow(0, 180, operationOrder), createRow(1, 220, operationOrder)];
		const instance = createMeasurementPort(elements.length, operationOrder);
		instance.scrollDirection = 'forward';
		const detach = elements.map((element) => manager.attach(element, instance));

		try {
			expect(instance.resizeItem).not.toHaveBeenCalled();
			await Promise.resolve();
			expect(operationOrder).toEqual(['read:0', 'read:1', 'write:0', 'write:1']);
			expect(vi.mocked(instance.resizeItem).mock.calls).toEqual([
				[0, 180],
				[1, 220],
			]);
		} finally {
			for (const cleanup of detach) cleanup();
			for (const element of elements) element.remove();
		}
	});

	it('does not remeasure when TanStack measured the row during attachment', async () => {
		const manager = new ConversationVirtualMeasurementManager(
			() => 'coasting',
			() => false,
		);
		const operationOrder: string[] = [];
		const element = createRow(0, 180, operationOrder);
		const instance = createMeasurementPort(1, operationOrder);
		instance.measureElement = vi.fn((attached) => {
			if (attached) instance.itemSizeCache.set('row-0', 180);
		});
		const detach = manager.attach(element, instance);

		try {
			await Promise.resolve();
			expect(operationOrder).toEqual([]);
			expect(instance.resizeItem).not.toHaveBeenCalled();
		} finally {
			detach();
			element.remove();
		}
	});

	it('revalidates a row index after an earlier write republishes geometry', async () => {
		const manager = new ConversationVirtualMeasurementManager(
			() => 'coasting',
			() => false,
		);
		const operationOrder: string[] = [];
		const elements = [createRow(0, 180, operationOrder), createRow(1, 220, operationOrder)];
		const instance = createMeasurementPort(2, operationOrder);
		const keys = ['row-0', 'row-1'];
		instance.options.getItemKey = (index) => keys[index];
		instance.resizeItem = vi.fn((index: number) => {
			operationOrder.push(`write:${index}`);
			if (index !== 0) return;
			keys.splice(1, 0, 'inserted');
			instance.options.count = 3;
			elements[1].dataset.index = '2';
		});
		const detach = elements.map((element) => manager.attach(element, instance));

		try {
			await Promise.resolve();
			expect(operationOrder).toEqual(['read:0', 'read:1', 'write:0', 'write:2']);
		} finally {
			for (const cleanup of detach) cleanup();
			for (const element of elements) element.remove();
		}
	});

	it('waits for pending row layout before publishing its first exact size', async () => {
		const manager = new ConversationVirtualMeasurementManager(
			() => 'coasting',
			() => false,
		);
		const operationOrder: string[] = [];
		const element = createRow(0, 180, operationOrder);
		const pending = document.createElement('span');
		pending.dataset.chatLayoutPending = 'true';
		element.append(pending);
		const instance = createMeasurementPort(1, operationOrder);
		const detach = manager.attach(element, instance);

		try {
			await Promise.resolve();
			expect(operationOrder).toEqual([]);
			pending.removeAttribute('data-chat-layout-pending');
			await waitFor(() => expect(instance.resizeItem).toHaveBeenCalledWith(0, 180));
			expect(operationOrder).toEqual(['read:0', 'write:0']);
		} finally {
			detach();
			element.remove();
		}
	});

	it('discards detached and rekeyed rows before reading layout', async () => {
		const manager = new ConversationVirtualMeasurementManager(
			() => 'coasting',
			() => false,
		);
		const operationOrder: string[] = [];
		const elements = [createRow(0, 180, operationOrder), createRow(1, 220, operationOrder)];
		const instance = createMeasurementPort(elements.length, operationOrder);
		const detach = elements.map((element) => manager.attach(element, instance));

		elements[0].remove();
		elements[1].dataset.chatVirtualItem = 'replacement';
		await Promise.resolve();

		expect(operationOrder).toEqual([]);
		expect(instance.resizeItem).not.toHaveBeenCalled();
		for (const cleanup of detach) cleanup();
		elements[1].remove();
	});

	it('clears queued first measurements without a later layout read or write', async () => {
		const manager = new ConversationVirtualMeasurementManager(
			() => 'coasting',
			() => false,
		);
		const operationOrder: string[] = [];
		const element = createRow(0, 180, operationOrder);
		const instance = createMeasurementPort(1, operationOrder);
		const detach = manager.attach(element, instance);

		manager.clear();
		await Promise.resolve();

		expect(operationOrder).toEqual([]);
		expect(instance.resizeItem).not.toHaveBeenCalled();
		detach();
		element.remove();
	});

	it('flushes a queued first measurement before programmatic ownership returns', async () => {
		let ownsScrollPosition = false;
		const manager = new ConversationVirtualMeasurementManager(
			() => 'coasting',
			() => ownsScrollPosition,
		);
		const operationOrder: string[] = [];
		const element = createRow(0, 180, operationOrder);
		const instance = createMeasurementPort(1, operationOrder);
		const detach = manager.attach(element, instance);

		try {
			ownsScrollPosition = true;
			manager.takeProgrammaticOwnership(instance);
			expect(operationOrder).toEqual(['read:0', 'write:0']);
			await Promise.resolve();
			expect(instance.resizeItem).toHaveBeenCalledOnce();
		} finally {
			detach();
			element.remove();
		}
	});

	it('reconciles a cached remount when programmatic scrolling takes ownership', () => {
		let ownsScrollPosition = false;
		const manager = new ConversationVirtualMeasurementManager(
			() => 'coasting',
			() => ownsScrollPosition,
		);
		const element = createRow(0, 40);
		const instance = createMeasurementPort(1, [], new Map([['row-0', 160]]));
		const detach = manager.attach(element, instance);

		try {
			manager.flush(instance);
			expect(instance.resizeItem).not.toHaveBeenCalled();
			ownsScrollPosition = true;
			manager.takeProgrammaticOwnership(instance);
			expect(instance.resizeItem).toHaveBeenCalledOnce();
			expect(instance.resizeItem).toHaveBeenCalledWith(0, 40);
		} finally {
			detach();
			element.remove();
		}
	});
});

it('publishes settlement when remounted rich content replaces its placeholder', async () => {
	const row = document.createElement('div');
	const pending = document.createElement('div');
	pending.dataset.chatLayoutPending = 'true';
	row.append(pending);
	const settled = vi.fn();
	const stop = observeConversationItemLayoutSettlement(row, settled);

	pending.removeAttribute('data-chat-layout-pending');

	await waitFor(() => expect(settled).toHaveBeenCalledOnce());
	stop();
});
