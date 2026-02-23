import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StartupCoordinator } from '../startup-coordinator';

describe('StartupCoordinator', () => {
	let coordinator: StartupCoordinator;

	beforeEach(() => {
		coordinator = new StartupCoordinator();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('starts with no pending startup', () => {
		expect(coordinator.currentPending).toBeNull();
		expect(coordinator.matchesPendingStartup('any-id')).toBe(false);
	});

	it('beginLocalStartup sets pending state', () => {
		coordinator.beginLocalStartup('chat-1');

		expect(coordinator.currentPending).not.toBeNull();
		expect(coordinator.currentPending?.chatId).toBe('chat-1');
		expect(coordinator.currentPending?.source).toBe('local-user');
	});

	it('matchesPendingStartup returns true for matching chat ID', () => {
		coordinator.beginLocalStartup('chat-1');
		expect(coordinator.matchesPendingStartup('chat-1')).toBe(true);
	});

	it('matchesPendingStartup returns false for non-matching chat ID', () => {
		coordinator.beginLocalStartup('chat-1');
		expect(coordinator.matchesPendingStartup('chat-2')).toBe(false);
	});

	it('matchesPendingStartup returns false when nothing is pending', () => {
		expect(coordinator.matchesPendingStartup('chat-1')).toBe(false);
	});

	it('completeStartup clears matching pending entry', () => {
		coordinator.beginLocalStartup('chat-1');
		coordinator.completeStartup('chat-1');

		expect(coordinator.currentPending).toBeNull();
		expect(coordinator.matchesPendingStartup('chat-1')).toBe(false);
	});

	it('completeStartup does not clear non-matching entry', () => {
		coordinator.beginLocalStartup('chat-1');
		coordinator.completeStartup('chat-2');

		expect(coordinator.currentPending).not.toBeNull();
		expect(coordinator.matchesPendingStartup('chat-1')).toBe(true);
	});

	it('clearExpiredStartup removes stale entries', () => {
		coordinator.beginLocalStartup('chat-1');

		vi.advanceTimersByTime(31_000);
		const cleared = coordinator.clearExpiredStartup(30_000);

		expect(cleared).toBe(true);
		expect(coordinator.currentPending).toBeNull();
	});

	it('clearExpiredStartup keeps non-expired entries', () => {
		coordinator.beginLocalStartup('chat-1');

		vi.advanceTimersByTime(10_000);
		const cleared = coordinator.clearExpiredStartup(30_000);

		expect(cleared).toBe(false);
		expect(coordinator.currentPending).not.toBeNull();
	});

	it('clearExpiredStartup returns false when nothing is pending', () => {
		expect(coordinator.clearExpiredStartup()).toBe(false);
	});

	it('clear removes any pending entry unconditionally', () => {
		coordinator.beginLocalStartup('chat-1');
		coordinator.clear();
		expect(coordinator.currentPending).toBeNull();
	});

	it('beginLocalStartup replaces previous pending entry', () => {
		coordinator.beginLocalStartup('chat-1');
		coordinator.beginLocalStartup('chat-2');

		expect(coordinator.matchesPendingStartup('chat-1')).toBe(false);
		expect(coordinator.matchesPendingStartup('chat-2')).toBe(true);
	});
});
