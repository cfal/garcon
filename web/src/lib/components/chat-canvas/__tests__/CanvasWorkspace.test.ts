import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CanvasController } from '$lib/chat-canvas/canvas-controller.svelte';
import { CanvasSession, type CanvasSessionPort } from '$lib/chat-canvas/canvas-session.svelte';
import { canvas, recoveryMemory } from '$lib/chat-canvas/__tests__/canvas-fixtures';
import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
import type { WorkspaceShortcutDispatcher } from '$lib/workspace/workspace-shortcuts';
import * as m from '$lib/paraglide/messages.js';
import CanvasWorkspace from '../CanvasWorkspace.svelte';

const shortcuts = vi.hoisted(() => ({ registerLocalShortcutOwner: vi.fn(() => vi.fn()) }));
vi.mock('$lib/context', () => ({
	getWorkspaceShortcuts: () =>
		shortcuts satisfies Pick<WorkspaceShortcutDispatcher, 'registerLocalShortcutOwner'>,
}));

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
	shortcuts.registerLocalShortcutOwner.mockClear();
});

const chat: ChatSessionRecord = {
	id: '1780000000000001',
	parentChat: null,
	projectPath: '/workspace/project',
	orderGroup: 'normal',
	title: 'Synthetic original chat',
	agentId: 'claude',
	model: 'sonnet',
	permissionMode: 'default',
	thinkingMode: 'none',
	agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
	createdAt: '2026-09-07T00:00:00Z',
	lastActivityAt: '2026-09-07T00:00:00Z',
	lastReadAt: null,
	isPinned: false,
	isArchived: false,
	isProcessing: false,
	processingPhase: null,
	canReloadFromNativeHistory: false,
	isUnread: false,
	status: 'running',
	agentOwnershipEpoch: null,
	tags: [],
};

describe('CanvasWorkspace visibility', () => {
	it('skips hidden catalog projections and restores fresh metadata without losing edits or selection', async () => {
		vi.useFakeTimers();
		const original = canvas();
		const api = {
			get: async () => original,
			update: vi.fn(async (request: Parameters<CanvasSessionPort['update']>[0]) =>
				canvas(request.content, request.expectedRevision + 1),
			),
		} satisfies CanvasSessionPort;
		const session = new CanvasSession(original, api, recoveryMemory().port, vi.fn());
		const controller = new CanvasController();
		controller.view = 'list';
		try {
			const view = render(CanvasWorkspace, {
				session,
				controller,
				chats: [chat],
				visible: true,
				presentation: 'window-main',
				onopen: vi.fn(),
				onbeside: undefined,
			});
			const card = screen.getByText(chat.title!).closest('li')!;
			await fireEvent.click(within(card).getByRole('button', { name: m.canvas_show_details() }));
			session.document.renameBox('box-a', 'Synthetic unsaved box');
			const edited = session.document.content;
			expect(session.dirty).toBe(true);
			expect(card.classList.contains('canvas-selected')).toBe(true);
			await view.rerender({ visible: false });
			expect(shortcuts.registerLocalShortcutOwner.mock.results[0].value).toHaveBeenCalledOnce();
			const intermediate = [{ ...chat, title: 'Synthetic intermediate chat' }];
			const latest = [{ ...chat, title: 'Synthetic latest chat', isArchived: true }];
			const intermediateProjection = vi.spyOn(intermediate, 'map');
			const latestProjection = vi.spyOn(latest, 'map');
			await view.rerender({ chats: intermediate });
			await view.rerender({ chats: latest });
			expect(intermediateProjection).not.toHaveBeenCalled();
			expect(latestProjection).not.toHaveBeenCalled();
			expect(screen.getByText(chat.title!)).toBeTruthy();
			expect(screen.queryByText('Synthetic latest chat')).toBeNull();
			await view.rerender({ visible: true });
			expect(latestProjection).toHaveBeenCalledOnce();
			expect(intermediateProjection).not.toHaveBeenCalled();
			expect(screen.queryByText(chat.title!)).toBeNull();
			expect(screen.getByText('Synthetic latest chat').closest('li')).toBe(card);
			expect(card.classList.contains('canvas-selected')).toBe(true);
			expect(screen.getByRole('combobox', { name: 'Move to box' })).toBeTruthy();
			expect(screen.getByRole('heading', { name: 'Synthetic unsaved box' })).toBeTruthy();
			expect(session.document.content).toBe(edited);
			expect(session.dirty).toBe(true);
			expect(api.update).not.toHaveBeenCalled();
			expect(shortcuts.registerLocalShortcutOwner).toHaveBeenCalledTimes(2);
			view.unmount();
			expect(shortcuts.registerLocalShortcutOwner.mock.results[1].value).toHaveBeenCalledOnce();
		} finally {
			session.dispose();
			controller.dispose();
		}
	});
});
