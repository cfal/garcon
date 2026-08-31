import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	TerminalAttachmentState,
	TerminalClientSession,
} from '$lib/terminal/sessions/terminal-registry.svelte.js';
import * as m from '$lib/paraglide/messages.js';
import TerminalWindowMenuItemsTestHost from './TerminalWindowMenuItemsTestHost.svelte';

const fakes = vi.hoisted(() => ({
	sessions: {} as Record<string, TerminalClientSession>,
	fontSize: '13',
	clipboardMessage: '',
	closeBlocked: false,
	pasteFromClipboard: vi.fn<() => Promise<boolean>>(),
	ensureRuntime: vi.fn(),
	reattach: vi.fn(),
	terminateTerminalSession: vi.fn<(terminalId: string) => Promise<boolean>>(),
	isSurfaceCloseBlocked: vi.fn<(surfaceId: string) => boolean>(),
	setLocalSetting: vi.fn(),
	notifyError: vi.fn(),
}));

vi.mock('$lib/context', () => ({
	getTerminalRegistry: () => ({
		get sessions() {
			return fakes.sessions;
		},
		ensureRuntime: fakes.ensureRuntime,
		reattach: fakes.reattach,
	}),
	getWorkspaceCoordinator: () => ({
		terminateTerminalSession: fakes.terminateTerminalSession,
		isSurfaceCloseBlocked: fakes.isSurfaceCloseBlocked,
	}),
	getLocalSettings: () => ({
		get terminalFontSize() {
			return fakes.fontSize;
		},
		set: fakes.setLocalSetting,
	}),
	getNotifications: () => ({ error: fakes.notifyError }),
	getOptionalTransientLayers: () => null,
}));

function terminalSession(attachmentState: TerminalAttachmentState): TerminalClientSession {
	return {
		metadata: {
			terminalId: 'terminal-1',
			displaySequence: 1,
			initialWorkingDirectory: '/workspace/project',
			processStatus: 'running',
			attachmentStatus: 'attached',
			createdAt: '2026-08-31T00:00:00.000Z',
			exitCode: null,
			latestOutputSequence: 0,
		},
		attachmentState,
		lastReceivedSequence: 0,
		replayTruncatedAt: null,
	};
}

async function openMenu(): Promise<void> {
	await fireEvent.click(screen.getByRole('button', { name: m.workspace_window_actions() }));
}

describe('TerminalWindowMenuItems', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		fakes.sessions = { 'terminal-1': terminalSession('attached') };
		fakes.fontSize = '13';
		fakes.clipboardMessage = '';
		fakes.closeBlocked = false;
		fakes.pasteFromClipboard.mockResolvedValue(true);
		fakes.ensureRuntime.mockImplementation(() => ({
			pasteFromClipboard: fakes.pasteFromClipboard,
			get clipboardMessage() {
				return fakes.clipboardMessage;
			},
		}));
		fakes.terminateTerminalSession.mockResolvedValue(true);
		fakes.isSurfaceCloseBlocked.mockImplementation(() => fakes.closeBlocked);
	});

	afterEach(cleanup);

	it('offers active terminal actions without duplicating terminal creation', async () => {
		render(TerminalWindowMenuItemsTestHost, { terminalId: 'terminal-1' });
		await openMenu();

		expect(screen.getByRole('menuitem', { name: m.terminal_paste() })).toBeTruthy();
		expect(screen.getByRole('menuitem', { name: /Font size 13px/ })).toBeTruthy();
		expect(screen.getByRole('menuitem', { name: m.terminal_terminate() })).toBeTruthy();
		expect(screen.queryByRole('menuitem', { name: m.terminal_reattach() })).toBeNull();
		expect(screen.queryByRole('menuitem', { name: m.workspace_new_terminal() })).toBeNull();

		await fireEvent.click(screen.getByRole('menuitem', { name: m.terminal_paste() }));
		await waitFor(() => expect(fakes.ensureRuntime).toHaveBeenCalledWith('terminal-1'));
		expect(fakes.pasteFromClipboard).toHaveBeenCalledOnce();
	});

	it('reattaches a detached terminal', async () => {
		fakes.sessions = { 'terminal-1': terminalSession('detached') };
		render(TerminalWindowMenuItemsTestHost, { terminalId: 'terminal-1' });
		await openMenu();

		await fireEvent.click(screen.getByRole('menuitem', { name: m.terminal_reattach() }));

		expect(fakes.reattach).toHaveBeenCalledWith('terminal-1');
	});

	it('persists font size from the terminal submenu', async () => {
		render(TerminalWindowMenuItemsTestHost, { terminalId: 'terminal-1' });
		await openMenu();

		const fontSize = screen.getByRole('menuitem', { name: /Font size 13px/ });
		fontSize.focus();
		await fireEvent.keyDown(fontSize, { key: 'ArrowRight' });
		await fireEvent.click(await screen.findByRole('menuitemradio', { name: '18px' }));

		expect(fakes.setLocalSetting).toHaveBeenCalledWith('terminalFontSize', '18');
	});

	it('terminates explicitly and reports clipboard feedback', async () => {
		fakes.clipboardMessage = m.shell_errors_clipboard_empty();
		fakes.pasteFromClipboard.mockResolvedValue(false);
		render(TerminalWindowMenuItemsTestHost, { terminalId: 'terminal-1' });
		await openMenu();
		await fireEvent.click(screen.getByRole('menuitem', { name: m.terminal_paste() }));

		await waitFor(() =>
			expect(fakes.notifyError).toHaveBeenCalledWith(m.shell_errors_clipboard_empty()),
		);
		await openMenu();
		await fireEvent.click(screen.getByRole('menuitem', { name: m.terminal_terminate() }));

		expect(fakes.terminateTerminalSession).toHaveBeenCalledWith('terminal-1');
	});
});
