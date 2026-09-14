import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocumentPollingCoordinator } from '$lib/files/persistence/document-polling-coordinator.js';

function documentTarget() {
	let visibilityState: DocumentVisibilityState = 'visible';
	const listeners = new Set<EventListenerOrEventListenerObject>();
	return {
		get visibilityState() {
			return visibilityState;
		},
		setVisibility(next: DocumentVisibilityState) {
			visibilityState = next;
			for (const listener of listeners) {
				if (typeof listener === 'function') listener(new Event('visibilitychange'));
				else listener.handleEvent(new Event('visibilitychange'));
			}
		},
		addEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
			listeners.add(listener);
		},
		removeEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
			listeners.delete(listener);
		},
	};
}

describe('DocumentPollingCoordinator', () => {
	it('stages hidden-view polling instead of bursting every document on page focus', async () => {
		vi.useFakeTimers();
		const target = documentTarget();
		target.setVisibility('hidden');
		const poll = vi.fn(async (_id: string) => undefined);
		const coordinator = new DocumentPollingCoordinator({
			poll,
			documentTarget: target,
			isVisible: (id) => id === 'shown',
		});
		try {
			coordinator.add('shown');
			coordinator.add('background');
			target.setVisibility('visible');
			expect(poll.mock.calls).toEqual([['shown']]);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(poll.mock.calls.filter(([id]) => id === 'background')).toHaveLength(1);
		} finally {
			coordinator.destroy();
		}
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('keeps polling cadence through unchanged visibility and does not poll hidden views immediately', async () => {
		vi.useFakeTimers();
		let visible = true;
		const poll = vi.fn(async () => undefined);
		const coordinator = new DocumentPollingCoordinator({
			poll,
			isVisible: () => visible,
			documentTarget: documentTarget(),
		});
		coordinator.add('document');
		await vi.advanceTimersByTimeAsync(10_000);
		coordinator.visibilityChanged('document');
		await vi.advanceTimersByTimeAsync(5_000);
		expect(poll).toHaveBeenCalledTimes(2);
		visible = false;
		coordinator.visibilityChanged('document');
		expect(poll).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(poll).toHaveBeenCalledTimes(3);
		visible = true;
		coordinator.visibilityChanged('document');
		expect(poll).toHaveBeenCalledTimes(4);
		coordinator.destroy();
	});

	it('deduplicates in-flight checks and retries after a rejected poll', async () => {
		vi.useFakeTimers();
		const pending = Promise.withResolvers<void>();
		const poll = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
		const error = new Error('revision unavailable');
		const report = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const target = documentTarget();
		const coordinator = new DocumentPollingCoordinator({
			poll,
			isVisible: () => true,
			documentTarget: target,
		});
		coordinator.add('document');
		target.setVisibility('hidden');
		target.setVisibility('visible');
		expect(poll).toHaveBeenCalledOnce();
		pending.reject(error);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(report).toHaveBeenCalledWith('File revision polling failed', error);
		expect(poll).toHaveBeenCalledTimes(2);
		coordinator.destroy();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(poll).toHaveBeenCalledTimes(2);
	});

	it('does not let a removed in-flight poll replace a new registration timer', async () => {
		vi.useFakeTimers();
		const pending = Promise.withResolvers<void>();
		const poll = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
		const coordinator = new DocumentPollingCoordinator({
			poll,
			isVisible: () => true,
			documentTarget: documentTarget(),
		});
		coordinator.add('document');
		coordinator.remove('document');
		coordinator.add('document');
		await vi.advanceTimersByTimeAsync(10_000);
		pending.resolve();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(poll).toHaveBeenCalledTimes(3);
		coordinator.destroy();
	});

	it('polls one document regardless of how many views reference it', async () => {
		const poll = vi.fn(async () => undefined);
		const target = documentTarget();
		const coordinator = new DocumentPollingCoordinator({
			poll,
			isVisible: () => true,
			documentTarget: target,
		});

		coordinator.add('document');
		coordinator.add('document');
		await vi.waitFor(() => expect(poll).toHaveBeenCalledOnce());
		coordinator.destroy();
	});

	it('checks immediately after a hidden document becomes visible', async () => {
		const poll = vi.fn(async () => undefined);
		const target = documentTarget();
		target.setVisibility('hidden');
		const coordinator = new DocumentPollingCoordinator({
			poll,
			isVisible: () => true,
			documentTarget: target,
		});
		coordinator.add('document');
		expect(poll).not.toHaveBeenCalled();

		target.setVisibility('visible');
		await vi.waitFor(() => expect(poll).toHaveBeenCalledOnce());
		coordinator.destroy();
	});
});
