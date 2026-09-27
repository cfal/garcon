import { render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { FileSessionRegistry } from '$lib/files/sessions/file-session-registry.svelte.js';
import FileDirtyUnloadGuardTestHost from './FileDirtyUnloadGuardTestHost.svelte';

function dispatchBeforeUnload(): boolean {
	const event = new Event('beforeunload', { cancelable: true });
	window.dispatchEvent(event);
	return event.defaultPrevented;
}

describe('FileDirtyUnloadGuard', () => {
	it('flushes best-effort drafts on pagehide without weakening the unload guard', async () => {
		const persist = vi
			.spyOn(FileSessionRegistry.prototype, 'flushRecovery')
			.mockResolvedValue(undefined);
		try {
			render(FileDirtyUnloadGuardTestHost, { dirty: true });
			window.dispatchEvent(new Event('pagehide'));
			await tick();

			expect(persist).toHaveBeenCalledOnce();
			expect(dispatchBeforeUnload()).toBe(true);
		} finally {
			persist.mockRestore();
		}
	});

	it('guards dirty buffers and active Saves', async () => {
		const view = render(FileDirtyUnloadGuardTestHost, { dirty: false, saving: false });
		expect(dispatchBeforeUnload()).toBe(false);

		await view.rerender({ dirty: true, saving: false });
		expect(dispatchBeforeUnload()).toBe(true);

		await view.rerender({ dirty: false, saving: true });
		expect(dispatchBeforeUnload()).toBe(true);

		await view.rerender({ dirty: false, saving: false });
		expect(dispatchBeforeUnload()).toBe(false);
	});
});
