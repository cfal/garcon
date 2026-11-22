import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import GitPushModal from '../GitPushModal.svelte';

afterEach(cleanup);

it('uses the selected remote and applies the same busy guard to keyboard and button', async () => {
	const props = {
		open: true,
		remotes: ['backup', 'origin'].map((name) => ({ name, url: `/repos/${name}` })),
		currentBranch: 'main',
		isPushing: false,
		onPush: vi.fn(),
		onClose: vi.fn(),
	};
	const view = render(GitPushModal, props);
	const dialog = await screen.findByRole('dialog', { name: 'Push to remote' });
	const push = within(dialog).getByRole('button', { name: 'Push' });
	await fireEvent.click(push);
	expect(props.onPush).toHaveBeenLastCalledWith('origin');
	await fireEvent.click(within(dialog).getByRole('radio', { name: /backup/ }));
	const close = within(dialog).getByRole('button', { name: 'Close' });
	close.focus();
	await fireEvent.keyDown(close, { key: 'Enter', ctrlKey: true });
	expect(props.onPush).toHaveBeenLastCalledWith('backup');
	expect(props.onClose).not.toHaveBeenCalled();

	await view.rerender({ ...props, isPushing: true });
	expect(push.hasAttribute('disabled')).toBe(true);
	await fireEvent.keyDown(dialog, { key: 'Enter', metaKey: true });
	expect(props.onPush).toHaveBeenCalledTimes(2);
	await fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
	expect(props.onClose).toHaveBeenCalledOnce();
});
