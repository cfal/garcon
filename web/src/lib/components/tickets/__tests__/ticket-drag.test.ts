import { expect, it, vi } from 'vitest';
import { ticketDropTarget } from '../ticket-drag';

it('registers dragging after a previous mount failed to load the adapter', async () => {
	const media = window.matchMedia('(pointer: fine)');
	vi.spyOn(media, 'matches', 'get').mockReturnValue(true);
	vi.spyOn(window, 'matchMedia').mockReturnValue(media);
	const options = { status: 'open' as const, onDrop: vi.fn() };
	const failed = vi.fn(() => { throw new Error('Synthetic chunk failure'); });
	const adapter = '@atlaskit/pragmatic-drag-and-drop/element/adapter';
	vi.doMock(adapter, failed);
	try {
		const first = ticketDropTarget(document.createElement('div'), options);
		await vi.dynamicImportSettled();
		expect(failed).toHaveBeenCalledOnce();
		first.destroy();
		const release = vi.fn();
		const register = vi.fn(() => release);
		vi.doMock(adapter, () => ({ dropTargetForElements: register }));
		const second = ticketDropTarget(document.createElement('div'), options);
		await vi.dynamicImportSettled();
		expect(register).toHaveBeenCalledOnce();
		second.destroy();
		expect(release).toHaveBeenCalledOnce();
	} finally {
		vi.doUnmock(adapter);
		vi.restoreAllMocks();
	}
});
