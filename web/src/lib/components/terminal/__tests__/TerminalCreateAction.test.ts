import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import TerminalCreateAction from '../TerminalCreateAction.svelte';
import type { TerminalRegistry } from '$lib/terminal/sessions/terminal-registry.svelte.js';

afterEach(cleanup);
function hosts(remoteAvailable = true, localFull = false) {
	return {
		hosts: [
			{ id: 'local', label: 'Local', available: true, full: localFull },
			{ id: 'remote', label: 'Build Server', available: remoteAvailable, full: false },
		],
		hasRemoteHosts: remoteAvailable,
		canCreate: (nodeId: string) => (nodeId === 'local' ? !localFull : remoteAvailable),
	} satisfies Pick<TerminalRegistry, 'hosts' | 'hasRemoteHosts' | 'canCreate'>;
}

it('opens a host chooser without spawning and preserves per-host admission', async () => {
	const oncreate = vi.fn();
	render(TerminalCreateAction, { terminals: hosts(true, true), oncreate });
	await fireEvent.click(screen.getByRole('button', { name: 'New Terminal' }));
	expect(oncreate).not.toHaveBeenCalled();
	expect(screen.getByRole('menuitem', { name: /^Local/ }).getAttribute('aria-disabled')).toBe(
		'true',
	);
	await fireEvent.click(screen.getByRole('menuitem', { name: 'Build Server' }));
	expect(oncreate).toHaveBeenCalledWith('remote');
});

it('keeps a disconnected host disabled rather than turning an open chooser into Local creation', async () => {
	const oncreate = vi.fn();
	const view = render(TerminalCreateAction, {
		terminals: hosts(),
		oncreate,
		defaultNodeId: 'remote',
	});
	await fireEvent.click(screen.getByRole('button', { name: 'New Terminal' }));
	await view.rerender({ terminals: hosts(false) });
	const unavailable = screen.getByRole('menuitem', { name: /^Build Server/ });
	expect(unavailable.getAttribute('aria-disabled')).toBe('true');
	await fireEvent.click(unavailable);
	expect(oncreate).not.toHaveBeenCalled();
	await fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
	expect(oncreate).not.toHaveBeenCalled();
});

it('keeps direct Local creation when no remote is available but never redirects a remote context', async () => {
	const oncreate = vi.fn();
	const view = render(TerminalCreateAction, {
		terminals: hosts(false),
		oncreate,
		defaultNodeId: 'remote',
	});
	const button = screen.getByRole('button', { name: 'New Terminal' });
	expect((button as HTMLButtonElement).disabled).toBe(true);
	await fireEvent.click(button);
	expect(oncreate).not.toHaveBeenCalled();
	await view.rerender({ defaultNodeId: 'local' });
	await fireEvent.click(button);
	expect(oncreate).toHaveBeenCalledOnce();
});
