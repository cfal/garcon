import { describe, expect, it, vi } from 'vitest';
import {
	registerManagedWorkspaceScrollRegion,
	registerNativeWorkspaceScrollRegion,
	scrollWorkspaceRegion,
	workspaceScrollRegionRole,
} from '../workspace-scroll-region';

describe('workspace scroll regions', () => {
	it('scrolls native regions by half their current viewport height', () => {
		const element = document.createElement('div');
		const scrollBy = vi.fn();
		Object.defineProperties(element, {
			clientHeight: { value: 640 },
			scrollBy: { value: scrollBy },
		});
		const unregister = registerNativeWorkspaceScrollRegion(element, 'primary');

		scrollWorkspaceRegion(element, 'earlier');
		scrollWorkspaceRegion(element, 'later');

		expect(scrollBy).toHaveBeenNthCalledWith(1, { top: -320, behavior: 'auto' });
		expect(scrollBy).toHaveBeenNthCalledWith(2, { top: 320, behavior: 'auto' });
		expect(workspaceScrollRegionRole(element)).toBe('primary');
		unregister();
		expect(workspaceScrollRegionRole(element)).toBeNull();
	});

	it('lets managed virtual regions own their scroll bookkeeping', () => {
		const element = document.createElement('div');
		const scrollBy = vi.fn();
		Object.defineProperty(element, 'scrollBy', { value: scrollBy });
		const handler = vi.fn();
		const unregister = registerManagedWorkspaceScrollRegion(
			element,
			'contextual',
			handler,
		);

		scrollWorkspaceRegion(element, 'later');

		expect(handler).toHaveBeenCalledWith(element, 'later');
		expect(scrollBy).not.toHaveBeenCalled();
		unregister();
		scrollWorkspaceRegion(element, 'earlier');
		expect(handler).toHaveBeenCalledOnce();
	});
});
