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
	it('handles rejected background view writes without weakening the unload guard', async () => {
		const persist = vi
			.spyOn(FileSessionRegistry.prototype, 'persistView')
			.mockRejectedValue(new Error('View storage unavailable'));
		try {
			render(FileDirtyUnloadGuardTestHost, { dirty: true });
			window.dispatchEvent(new Event('pagehide'));
			await tick();

			expect(persist).toHaveBeenCalledWith('file-view');
			expect(dispatchBeforeUnload()).toBe(true);
		} finally {
			persist.mockRestore();
		}
	});

	it('guards dirty buffers and every nonterminal Save state', async () => {
		const view = render(FileDirtyUnloadGuardTestHost, { dirty: false, saveOutcome: 'idle' });
		expect(dispatchBeforeUnload()).toBe(false);

		await view.rerender({ dirty: true, saveOutcome: 'idle' });
		expect(dispatchBeforeUnload()).toBe(true);

		await view.rerender({ dirty: false, saveOutcome: 'saving' });
		expect(dispatchBeforeUnload()).toBe(true);

		await view.rerender({ dirty: false, saveOutcome: 'unknown' });
		expect(dispatchBeforeUnload()).toBe(true);

		await view.rerender({ dirty: false, saveOutcome: 'idle' });
		expect(dispatchBeforeUnload()).toBe(false);
	});
});
