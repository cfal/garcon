import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import FileDirtyUnloadGuardTestHost from './FileDirtyUnloadGuardTestHost.svelte';

function dispatchBeforeUnload(): boolean {
	const event = new Event('beforeunload', { cancelable: true });
	window.dispatchEvent(event);
	return event.defaultPrevented;
}

describe('FileDirtyUnloadGuard', () => {
	it('guards only while at least one file session is dirty', async () => {
		const view = render(FileDirtyUnloadGuardTestHost, { dirty: false });
		expect(dispatchBeforeUnload()).toBe(false);

		await view.rerender({ dirty: true });
		expect(dispatchBeforeUnload()).toBe(true);

		await view.rerender({ dirty: false });
		expect(dispatchBeforeUnload()).toBe(false);
	});
});
