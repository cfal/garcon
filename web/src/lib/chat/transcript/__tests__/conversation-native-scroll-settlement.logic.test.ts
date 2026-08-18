import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	ConversationNativeScrollSettlement,
	NATIVE_SCROLL_SETTLE_DELAY_MS,
} from '../conversation-native-scroll-settlement.js';

afterEach(() => {
	vi.useRealTimers();
});

describe('ConversationNativeScrollSettlement', () => {
	it('keeps a directionless touch stateless', async () => {
		const onActivityChange = vi.fn();
		const settlement = new ConversationNativeScrollSettlement(onActivityChange);

		settlement.noteTouch('start');
		settlement.noteTouch('end');

		expect(settlement.activity).toBe('idle');
		expect(onActivityChange).not.toHaveBeenCalled();
		await expect(settlement.waitUntilIdle()).resolves.toBe('settled');
	});

	it('waits for a complete quiet interval after touch momentum', async () => {
		vi.useFakeTimers();
		const onActivityChange = vi.fn();
		const settlement = new ConversationNativeScrollSettlement(onActivityChange);
		let completed: string | null = null;

		settlement.noteTouch('start');
		settlement.noteTouch('move');
		const wait = settlement.waitUntilIdle().then((result) => {
			completed = result;
			return result;
		});
		settlement.noteTouch('end');
		await vi.advanceTimersByTimeAsync(NATIVE_SCROLL_SETTLE_DELAY_MS - 1);
		expect(completed).toBeNull();

		settlement.noteScroll();
		await vi.advanceTimersByTimeAsync(NATIVE_SCROLL_SETTLE_DELAY_MS - 1);
		expect(completed).toBeNull();
		await vi.advanceTimersByTimeAsync(1);

		await expect(wait).resolves.toBe('settled');
		expect(onActivityChange.mock.calls).toEqual([['dragging'], ['coasting'], ['idle']]);
	});

	it('does not let an older coast timer release a new drag', async () => {
		vi.useFakeTimers();
		const settlement = new ConversationNativeScrollSettlement(vi.fn());

		settlement.noteTouch('move');
		settlement.noteTouch('end');
		await vi.advanceTimersByTimeAsync(NATIVE_SCROLL_SETTLE_DELAY_MS / 2);
		settlement.noteTouch('start');
		settlement.noteTouch('move');
		await vi.advanceTimersByTimeAsync(NATIVE_SCROLL_SETTLE_DELAY_MS);

		expect(settlement.activity).toBe('dragging');
		settlement.noteTouch('end');
		await vi.advanceTimersByTimeAsync(NATIVE_SCROLL_SETTLE_DELAY_MS);
		expect(settlement.activity).toBe('idle');
	});

	it('invalidates a waiter when its surface is cancelled', async () => {
		const settlement = new ConversationNativeScrollSettlement(vi.fn());
		settlement.noteTouch('move');
		const wait = settlement.waitUntilIdle();

		settlement.cancel();

		await expect(wait).resolves.toBe('cancelled');
		expect(settlement.activity).toBe('idle');
	});
});
