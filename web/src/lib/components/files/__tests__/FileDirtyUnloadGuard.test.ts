import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import FileDirtyUnloadGuardTestHost from './FileDirtyUnloadGuardTestHost.svelte';

function dispatchBeforeUnload(): boolean {
	const event = new Event('beforeunload', { cancelable: true });
	window.dispatchEvent(event);
	return event.defaultPrevented;
}

describe('FileDirtyUnloadGuard', () => {
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
