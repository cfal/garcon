import { describe, expect, it, vi } from 'vitest';
import { EmptyWorkspaceLandingController } from '../empty-workspace-landing-controller';

const emptyWorkspace = {
	chatListStatus: 'ready' as const,
	chatListError: null,
	chatCount: 0,
	isBareRoute: true,
	hasNavigationTarget: false,
	newChatDialogOpen: false,
	anotherDialogOpen: false,
};

describe('EmptyWorkspaceLandingController', () => {
	it('waits for successful hydration and opens once per empty period', () => {
		const open = vi.fn();
		const controller = new EmptyWorkspaceLandingController(open);
		controller.observe({ ...emptyWorkspace, chatListStatus: 'loading' });
		controller.observe({ ...emptyWorkspace, chatListStatus: 'error', chatListError: 'Unavailable' });
		controller.observe({ ...emptyWorkspace, chatListError: 'Refresh failed' });
		expect(open).not.toHaveBeenCalled();
		controller.observe(emptyWorkspace);
		controller.observe(emptyWorkspace);
		expect(open).toHaveBeenCalledOnce();
	});

	it('preserves dismissal across close, refresh and reconnect updates', () => {
		const open = vi.fn();
		const controller = new EmptyWorkspaceLandingController(open);
		controller.observe(emptyWorkspace);
		controller.observe({ ...emptyWorkspace, newChatDialogOpen: true });
		controller.observe(emptyWorkspace);
		controller.observe({ ...emptyWorkspace, chatListStatus: 'loading' });
		controller.observe(emptyWorkspace);
		expect(open).toHaveBeenCalledOnce();
	});

	it('counts every existing chat or draft and reopens after the last one is removed', () => {
		const open = vi.fn();
		const controller = new EmptyWorkspaceLandingController(open);
		controller.observe(emptyWorkspace);
		controller.observe({ ...emptyWorkspace, chatCount: 1 });
		controller.observe({ ...emptyWorkspace, hasNavigationTarget: true });
		expect(open).toHaveBeenCalledOnce();
		controller.observe(emptyWorkspace);
		expect(open).toHaveBeenCalledTimes(2);
	});

	it.each([
		{ chatCount: 1 },
		{ isBareRoute: false },
		{ hasNavigationTarget: true },
		{ anotherDialogOpen: true },
	])('preserves existing navigation and dialogs: %j', (blocked) => {
		const open = vi.fn();
		new EmptyWorkspaceLandingController(open).observe({ ...emptyWorkspace, ...blocked });
		expect(open).not.toHaveBeenCalled();
	});

	it('preserves an explicitly opened seeded dialog and its subsequent dismissal', () => {
		const open = vi.fn();
		const controller = new EmptyWorkspaceLandingController(open);
		controller.observe({ ...emptyWorkspace, chatListStatus: 'loading', newChatDialogOpen: true });
		controller.observe(emptyWorkspace);
		expect(open).not.toHaveBeenCalled();
	});

	it('waits for onboarding or settings to close before opening the empty landing', () => {
		const open = vi.fn();
		const controller = new EmptyWorkspaceLandingController(open);
		controller.observe({ ...emptyWorkspace, anotherDialogOpen: true });
		expect(open).not.toHaveBeenCalled();
		controller.observe(emptyWorkspace);
		expect(open).toHaveBeenCalledOnce();
	});
});
