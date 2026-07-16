import { describe, expect, it, vi } from 'vitest';

import {
	scheduleInitialTranscriptReveal,
	type InitialTranscriptRevealScheduler,
} from '../initial-transcript-reveal';

function createScheduler() {
	let nextId = 1;
	const frames = new Map<number, FrameRequestCallback>();
	const idleCallbacks = new Map<number, IdleRequestCallback>();
	const timeoutCallbacks = new Map<number, TimerHandler>();
	const scheduler: InitialTranscriptRevealScheduler = {
		requestAnimationFrame: vi.fn((callback) => {
			const id = nextId++;
			frames.set(id, callback);
			return id;
		}),
		cancelAnimationFrame: vi.fn((id) => frames.delete(id)),
		requestIdleCallback: vi.fn((callback) => {
			const id = nextId++;
			idleCallbacks.set(id, callback);
			return id;
		}),
		cancelIdleCallback: vi.fn((id) => idleCallbacks.delete(id)),
		setTimeout: vi.fn((callback) => {
			const id = nextId++;
			timeoutCallbacks.set(id, callback);
			return id;
		}),
		clearTimeout: vi.fn((id) => timeoutCallbacks.delete(id)),
	};
	const runNextFrame = () => {
		const [id, callback] = frames.entries().next().value ?? [];
		if (id === undefined || !callback) throw new Error('No frame scheduled');
		frames.delete(id);
		callback(0);
	};

	return { idleCallbacks, scheduler, runNextFrame };
}

describe('scheduleInitialTranscriptReveal', () => {
	it('waits for two frames before scheduling idle work', () => {
		const { idleCallbacks, scheduler, runNextFrame } = createScheduler();
		const reveal = vi.fn();

		scheduleInitialTranscriptReveal(reveal, scheduler);
		runNextFrame();
		expect(idleCallbacks).toHaveLength(0);
		runNextFrame();
		expect(idleCallbacks).toHaveLength(1);

		idleCallbacks
			.values()
			.next()
			.value?.({ didTimeout: false, timeRemaining: () => 10 });
		expect(reveal).toHaveBeenCalledOnce();
	});

	it('cancels a pending reveal when another chat activates', () => {
		const { idleCallbacks, scheduler, runNextFrame } = createScheduler();
		const reveal = vi.fn();
		const cancel = scheduleInitialTranscriptReveal(reveal, scheduler);
		runNextFrame();
		runNextFrame();
		const idleCallback = idleCallbacks.values().next().value;

		cancel();
		idleCallback?.({ didTimeout: false, timeRemaining: () => 10 });

		expect(scheduler.cancelIdleCallback).toHaveBeenCalledOnce();
		expect(reveal).not.toHaveBeenCalled();
	});
});
