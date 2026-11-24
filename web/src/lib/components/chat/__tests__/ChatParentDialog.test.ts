import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
import ChatParentDialog from '../ChatParentDialog.svelte';

const CHILD = '1783725900000200';
const PARENT = '1783725900000201';
const OTHER = '1783725900000202';
function chat(id: string, title = 'Duplicate'): ChatSessionRecord {
	return {
		id,
		title,
		parentChatId: null,
		lineage: null,
		projectPath: '/project',
		executorId: 'offline-executor',
		orderGroup: 'normal',
		agentId: 'test',
		model: null,
		permissionMode: 'default',
		thinkingMode: 'none',
		agentSettings: { ownerId: 'test', schemaVersion: 1, values: {} },
		createdAt: null,
		lastActivityAt: null,
		lastReadAt: null,
		isPinned: false,
		isArchived: false,
		isProcessing: true,
		processingPhase: null,
		activityStatus: null,
		canReloadFromNativeHistory: false,
		isUnread: false,
		status: 'running',
		agentOwnershipEpoch: 'epoch',
		tags: [],
	};
}
function props() {
	return {
		parentDialog: { chatId: CHILD, chatTitle: 'Target' },
		chats: [chat(CHILD, 'Target'), chat(PARENT), chat(OTHER)],
		isConnected: true,
		executorLabel: () => 'Offline executor',
		onRefresh: vi.fn(async () => {}),
		onClose: vi.fn(),
		onConfirm: vi.fn(async (_chatId: string, _parentId: string | null) => {}),
	};
}
afterEach(cleanup);

describe('ChatParentDialog', () => {
	it('wraps keyboard suggestions and leaves empty results unselected', async () => {
		const callbacks = props();
		render(ChatParentDialog, callbacks);
		const input = screen.getByRole('combobox');
		const options = screen.getAllByRole('option');
		await fireEvent.keyDown(input, { key: 'ArrowUp' });
		expect(options.at(-1)?.getAttribute('aria-selected')).toBe('true');
		await fireEvent.keyDown(input, { key: 'ArrowDown' });
		expect(options[0]?.getAttribute('aria-selected')).toBe('true');
		await fireEvent.keyDown(input, { key: 'ArrowUp' });
		expect(options.at(-1)?.getAttribute('aria-selected')).toBe('true');
		await fireEvent.input(input, { target: { value: 'No matching title' } });
		await fireEvent.keyDown(input, { key: 'ArrowUp' });
		await fireEvent.keyDown(input, { key: 'ArrowDown' });
		await fireEvent.keyDown(input, { key: 'Enter' });
		expect(screen.queryAllByRole('option')).toHaveLength(0);
		expect(callbacks.onConfirm).not.toHaveBeenCalled();
	});

	it('leaves composing Escape and Safari Enter to the input method', async () => {
		const callbacks = props();
		render(ChatParentDialog, callbacks);
		const input = screen.getByRole('combobox');
		await fireEvent.input(input, { target: { value: 'Duplicate' } });
		await fireEvent.keyDown(input, { key: 'ArrowDown' });
		await fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
		expect(screen.queryByRole('listbox')).not.toBeNull();
		expect(callbacks.onConfirm).not.toHaveBeenCalled();
		const escape = new KeyboardEvent('keydown', {
			key: 'Escape',
			isComposing: true,
			bubbles: true,
			cancelable: true,
		});
		await fireEvent(input, escape);
		expect(callbacks.onClose).not.toHaveBeenCalled();
		expect(escape.defaultPrevented).toBe(false);
	});

	it('keeps a pending save visible and the input focusable until a rejection is shown', async () => {
		const callbacks = props();
		const pending = Promise.withResolvers<void>();
		callbacks.onConfirm.mockReturnValueOnce(pending.promise);
		render(ChatParentDialog, callbacks);
		const input = screen.getByRole<HTMLInputElement>('combobox');
		await fireEvent.input(input, { target: { value: PARENT } });
		input.focus();
		await fireEvent.keyDown(input, { key: 'Enter' });
		expect(input.readOnly).toBe(true);
		expect(input.disabled).toBe(false);
		expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true);
		await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		await fireEvent.keyDown(input, { key: 'Escape' });
		await fireEvent.keyDown(input, { key: 'Escape' });
		expect(callbacks.onClose).not.toHaveBeenCalled();
		expect(screen.getByRole('dialog').getAttribute('data-state')).toBe('open');
		pending.reject(new Error('Parent chat not found'));
		await waitFor(() =>
			expect(screen.getByRole('alert').textContent).toContain('Parent chat not found'),
		);
		expect(input.readOnly).toBe(false);
		expect(document.activeElement).toBe(input);
	});

	it('requires an explicit title choice, accepts keyboard selection, and does not gate offline executors', async () => {
		const callbacks = props();
		render(ChatParentDialog, callbacks);
		const input = screen.getByRole('combobox');
		await fireEvent.input(input, { target: { value: 'Duplicate' } });
		expect(screen.getAllByRole('option')).toHaveLength(2);
		expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
		await fireEvent.keyDown(input, { key: 'Enter' });
		expect(callbacks.onConfirm).not.toHaveBeenCalled();
		await fireEvent.keyDown(input, { key: 'ArrowDown' });
		await fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
		expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
		await fireEvent.keyDown(input, { key: 'Enter' });
		expect(callbacks.onConfirm).not.toHaveBeenCalled();
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(callbacks.onClose).toHaveBeenCalledOnce());
		expect(callbacks.onConfirm).toHaveBeenCalledWith(CHILD, OTHER);
		expect(callbacks.onRefresh).toHaveBeenCalledOnce();
	});

	it('invalidates clicked selections when typing and accepts a full ID absent from the roster', async () => {
		const callbacks = props();
		render(ChatParentDialog, callbacks);
		await fireEvent.click(screen.getAllByRole('option')[0]!);
		const input = screen.getByRole('combobox');
		await fireEvent.input(input, { target: { value: 'Duplicate' } });
		expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
		await fireEvent.input(input, { target: { value: '1783725900000299' } });
		await fireEvent.keyDown(input, { key: 'Enter' });
		expect(callbacks.onConfirm).toHaveBeenCalledWith(CHILD, '1783725900000299');
	});

	it('keeps typed proposals across roster changes and stages clear explicitly', async () => {
		const callbacks = props();
		callbacks.chats[0]!.parentChatId = PARENT;
		const rendered = render(ChatParentDialog, callbacks);
		const input = screen.getByRole('combobox');
		await fireEvent.input(input, { target: { value: OTHER } });
		await rendered.rerender({
			chats: callbacks.chats.map((entry) =>
				entry.id === CHILD ? { ...entry, parentChatId: null, lineage: null } : entry,
			),
		});
		expect((input as HTMLInputElement).value).toBe(OTHER);
		await rendered.rerender({ chats: callbacks.chats });
		await rendered.rerender({ parentDialog: callbacks.parentDialog });
		expect((input as HTMLInputElement).value).toBe(OTHER);
		expect(callbacks.onRefresh).toHaveBeenCalledOnce();
		await fireEvent.input(input, { target: { value: '' } });
		expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
		await fireEvent.click(screen.getByRole('button', { name: 'Remove parent' }));
		expect(callbacks.onConfirm).not.toHaveBeenCalled();
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		expect(callbacks.onConfirm).toHaveBeenCalledWith(CHILD, null);
	});

	it('preserves failed input and applies the same offline gate to Enter and Save', async () => {
		const callbacks = props();
		callbacks.onConfirm.mockRejectedValueOnce(new Error('Parent chat not found'));
		const rendered = render(ChatParentDialog, callbacks);
		const input = screen.getByRole('combobox');
		await fireEvent.input(input, { target: { value: PARENT } });
		await fireEvent.keyDown(input, { key: 'Enter' });
		await waitFor(() =>
			expect(screen.getByRole('alert').textContent).toContain('Parent chat not found'),
		);
		expect((input as HTMLInputElement).value).toBe(PARENT);
		await rendered.rerender({ isConnected: false });
		expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
		await fireEvent.keyDown(input, { key: 'Enter' });
		expect(callbacks.onConfirm).toHaveBeenCalledTimes(1);
		await rendered.rerender({ chats: callbacks.chats.slice(1), isConnected: true });
		expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
	});

	it.each(['fork', 'handoff'] as const)(
		'assigns delegation without replacing %s ancestry',
		async (kind) => {
			const callbacks = props();
			callbacks.chats[0]!.lineage = {
				sourceChatId: PARENT,
				kind,
				transcriptViewId: 'view',
				ordinal: 0,
			};
			render(ChatParentDialog, callbacks);
			await fireEvent.input(screen.getByRole('combobox'), { target: { value: OTHER } });
			await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
			expect(callbacks.onConfirm).toHaveBeenCalledWith(CHILD, OTHER);
			expect(callbacks.chats[0]!.lineage).toEqual({
				sourceChatId: PARENT,
				kind,
				transcriptViewId: 'view',
				ordinal: 0,
			});
		},
	);

	it('does not close or alter a newly opened target when an older save completes', async () => {
		const callbacks = props();
		const pending = Promise.withResolvers<void>();
		callbacks.onConfirm.mockReturnValueOnce(pending.promise);
		const rendered = render(ChatParentDialog, callbacks);
		await fireEvent.input(screen.getByRole('combobox'), { target: { value: PARENT } });
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await rendered.rerender({ parentDialog: { chatId: OTHER, chatTitle: 'Other' } });
		await fireEvent.input(screen.getByRole('combobox'), { target: { value: CHILD } });
		pending.resolve();
		await pending.promise;
		expect(callbacks.onClose).not.toHaveBeenCalled();
		expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe(CHILD);
	});
});
