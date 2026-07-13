import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalWorkspaceSnapshot } from '$lib/stores/workspace-layout.svelte';
import {
	WORKSPACE_PERSISTENCE_DELAY_MS,
	WorkspaceLayoutPersistence,
} from '../workspace-layout-persistence';

afterEach(() => {
	vi.useRealTimers();
	Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

describe('WorkspaceLayoutPersistence', () => {
	it('coalesces writes and persists the latest snapshot after 250 milliseconds', () => {
		vi.useFakeTimers();
		const write = vi.fn();
		const persistence = new WorkspaceLayoutPersistence({ write });
		const first = canonicalWorkspaceSnapshot();
		const second = { ...first, desiredSidebarWidth: 620 };

		persistence.schedule(first);
		persistence.schedule(second);
		vi.advanceTimersByTime(WORKSPACE_PERSISTENCE_DELAY_MS - 1);
		expect(write).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);

		expect(write).toHaveBeenCalledOnce();
		expect(JSON.parse(write.mock.calls[0][1]).desiredSidebarWidth).toBe(620);
		persistence.destroy();
	});

	it('flushes on pagehide and hidden visibility, then removes listeners', () => {
		vi.useFakeTimers();
		const write = vi.fn();
		const persistence = new WorkspaceLayoutPersistence({ write });
		persistence.schedule(canonicalWorkspaceSnapshot());
		window.dispatchEvent(new PageTransitionEvent('pagehide'));
		expect(write).toHaveBeenCalledOnce();

		persistence.schedule({ ...canonicalWorkspaceSnapshot(), desiredSidebarWidth: 700 });
		Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
		document.dispatchEvent(new Event('visibilitychange'));
		expect(write).toHaveBeenCalledTimes(2);

		persistence.destroy();
		persistence.schedule({ ...canonicalWorkspaceSnapshot(), desiredSidebarWidth: 800 });
		window.dispatchEvent(new PageTransitionEvent('pagehide'));
		expect(write).toHaveBeenCalledTimes(2);
	});

	it('stops automatic retries after storage failure and exposes an explicit retry', () => {
		vi.useFakeTimers();
		let shouldFail = true;
		const write = vi.fn<(key: string, value: string) => void>(() => {
			if (shouldFail) throw new DOMException('Quota exceeded', 'QuotaExceededError');
		});
		const onError = vi.fn();
		const persistence = new WorkspaceLayoutPersistence({ write, onError });

		persistence.schedule(canonicalWorkspaceSnapshot());
		vi.advanceTimersByTime(WORKSPACE_PERSISTENCE_DELAY_MS);
		expect(persistence.hasError).toBe(true);
		expect(onError).toHaveBeenCalledOnce();

		persistence.schedule({ ...canonicalWorkspaceSnapshot(), desiredSidebarWidth: 640 });
		vi.advanceTimersByTime(WORKSPACE_PERSISTENCE_DELAY_MS * 2);
		expect(write).toHaveBeenCalledOnce();

		shouldFail = false;
		expect(persistence.retry()).toBe(true);
		expect(persistence.hasError).toBe(false);
		expect(JSON.parse(write.mock.calls.at(-1)?.[1] ?? '{}').desiredSidebarWidth).toBe(640);
		persistence.destroy();
	});
});
