import { fireEvent, render, screen } from '@testing-library/svelte';
import { expect, it, vi } from 'vitest';
import Host from './FileDirtyUnloadGuardTestHost.svelte';

it('offers reload rather than a failed-import retry and disables it while work is protected', async () => {
	const onReload = vi.fn();
	const rendered = render(Host, { dirty: true, showVimError: true, onReload });
	const reload = screen.getByRole<HTMLButtonElement>('button', { name: 'Reload application' });
	expect(reload.disabled).toBe(true);
	expect(screen.queryByRole('button', { name: 'Retry Vim mode' })).toBeNull();
	await fireEvent.click(reload);
	expect(onReload).not.toHaveBeenCalled();
	await rendered.rerender({ dirty: false, saving: true, showVimError: true, onReload });
	expect(reload.disabled).toBe(true);
	await rendered.rerender({ dirty: false, saving: false, showVimError: true, onReload });
	expect(reload.disabled).toBe(false);
	await fireEvent.click(reload);
	expect(onReload).toHaveBeenCalledOnce();
});
