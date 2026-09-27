import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { tick } from 'svelte';
import FileDirtyUnloadGuardTestHost from './FileDirtyUnloadGuardTestHost.svelte';

function dispatchBeforeUnload(): boolean {
	const event = new Event('beforeunload', { cancelable: true });
	window.dispatchEvent(event);
	return event.defaultPrevented;
}

describe('FileDirtyUnloadGuard', () => {
	it('retains the unload guard after pagehide and cleans it up on unmount', async () => {
		const view = render(FileDirtyUnloadGuardTestHost, { dirty: true });
		window.dispatchEvent(new Event('pagehide'));
		await tick();
		expect(dispatchBeforeUnload()).toBe(true);
		view.unmount();
		expect(dispatchBeforeUnload()).toBe(false);
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
