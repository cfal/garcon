import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MinuteClockStore } from '../minute-clock.svelte';

describe('MinuteClockStore', () => {
	let clock: MinuteClockStore | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2030-01-01T12:00:23Z'));
	});

	afterEach(() => {
		clock?.destroy();
		clock = undefined;
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('aligns the initial tick to the next minute and keeps one timer', () => {
		clock = new MinuteClockStore();
		expect(clock.currentTime.toISOString()).toBe('2030-01-01T12:00:23.000Z');
		vi.advanceTimersByTime(36_999);
		expect(clock.currentTime.toISOString()).toBe('2030-01-01T12:00:23.000Z');
		vi.advanceTimersByTime(1);
		expect(clock.currentTime.toISOString()).toBe('2030-01-01T12:01:00.000Z');
		vi.advanceTimersByTime(60_000);
		expect(clock.currentTime.toISOString()).toBe('2030-01-01T12:02:00.000Z');
		expect(vi.getTimerCount()).toBe(1);
	});

	it('waits a full minute when created exactly on the boundary', () => {
		vi.setSystemTime(new Date('2030-01-01T12:00:00Z'));
		clock = new MinuteClockStore();
		vi.advanceTimersByTime(59_999);
		expect(clock.currentTime.toISOString()).toBe('2030-01-01T12:00:00.000Z');
		vi.advanceTimersByTime(1);
		expect(clock.currentTime.toISOString()).toBe('2030-01-01T12:01:00.000Z');
	});

	it('refreshes immediately on becoming visible without adding a timer', () => {
		clock = new MinuteClockStore();
		const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
		vi.setSystemTime(new Date('2030-01-01T13:00:00Z'));
		document.dispatchEvent(new Event('visibilitychange'));
		expect(clock.currentTime.toISOString()).toBe('2030-01-01T12:00:23.000Z');
		visibility.mockReturnValue('visible');
		document.dispatchEvent(new Event('visibilitychange'));
		expect(clock.currentTime.toISOString()).toBe('2030-01-01T13:00:00.000Z');
		expect(vi.getTimerCount()).toBe(1);
	});

	it.each([0, 37_000])('cleans up timers and visibility listener after %i ms', (elapsed) => {
		clock = new MinuteClockStore();
		vi.advanceTimersByTime(elapsed);
		const lastTime = clock.currentTime;
		clock.destroy();
		clock.destroy();
		vi.advanceTimersByTime(120_000);
		vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
		document.dispatchEvent(new Event('visibilitychange'));
		expect(clock.currentTime).toBe(lastTime);
		expect(vi.getTimerCount()).toBe(0);
	});
});
