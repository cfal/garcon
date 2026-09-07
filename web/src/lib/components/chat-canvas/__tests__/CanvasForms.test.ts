import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import { CanvasDocumentState } from '$lib/chat-canvas/canvas-document.svelte';
import { canvasContent, deferred } from '$lib/chat-canvas/__tests__/canvas-fixtures';
import CanvasNameDialog from '../CanvasNameDialog.svelte';
import CanvasConfirmDialog from '../CanvasConfirmDialog.svelte';
import CanvasChatPicker from '../CanvasChatPicker.svelte';
import CanvasConnectionDialog from '../CanvasConnectionDialog.svelte';
import CanvasInspector from '../CanvasInspector.svelte';

afterEach(cleanup);
const chat: ChatSessionRecord = {
	id: '1780000000000001',
	parentChat: null,
	projectPath: '/workspace/project',
	orderGroup: 'normal',
	title: 'Research chat',
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
	isUnread: true,
	status: 'running',
	agentOwnershipEpoch: null,
	tags: ['architecture'],
};

describe('Canvas forms', () => {
	it('rejects selected edges and endpoints removed while connecting', async () => {
		const connect = vi.fn(() => true);
		const view = render(CanvasConnectionDialog, {
			nodes: canvasContent().nodes,
			chats: {},
			initialSource: 'edge',
			onconnect: connect,
			onclose: vi.fn(),
		});
		await fireEvent.change(screen.getByLabelText('To'), { target: { value: 'box-b' } });
		const form = screen.getByLabelText('From').closest('form')!;
		await fireEvent.submit(form);
		expect(connect).not.toHaveBeenCalled();
		await fireEvent.change(screen.getByLabelText('From'), { target: { value: 'box-a' } });
		await view.rerender({ nodes: canvasContent().nodes.filter((node) => node.id !== 'box-b') });
		expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Connect' }).disabled).toBe(true);
		await fireEvent.submit(form);
		expect(connect).not.toHaveBeenCalled();
	});

	it('requires a current box after its selected destination disappears', async () => {
		const add = vi.fn(() => true);
		const view = render(CanvasChatPicker, {
			chats: [chat],
			boxes: canvasContent().nodes.filter((node) => node.type === 'box'),
			initialBox: 'box-a',
			capacity: 1,
			onadd: add,
			onclose: vi.fn(),
		});
		await fireEvent.click(screen.getByRole('checkbox'));
		await view.rerender({ boxes: [] });
		await fireEvent.submit(screen.getByRole('searchbox').closest('form')!);
		expect(add).not.toHaveBeenCalled();
		await fireEvent.change(screen.getByLabelText('Move to box'), { target: { value: '' } });
		await fireEvent.submit(screen.getByRole('searchbox').closest('form')!);
		expect(add).toHaveBeenCalledExactlyOnceWith([chat.id], null);
	});

	it('gates name submission for empty names and in-flight saves, and keeps failures reviewable', async () => {
		const response = deferred<boolean>();
		const submit = vi.fn(() => response.promise);
		const close = vi.fn();
		render(CanvasNameDialog, { title: 'Create canvas', onsubmit: submit, onclose: close });
		const input = screen.getByRole('textbox');
		const form = input.closest('form')!;
		await fireEvent.submit(form);
		expect(submit).not.toHaveBeenCalled();
		await fireEvent.input(input, { target: { value: '  Project  ' } });
		await fireEvent.submit(form);
		await fireEvent.submit(form);
		expect(submit).toHaveBeenCalledExactlyOnceWith('Project');
		expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Apply' }).disabled).toBe(true);
		response.reject(new Error('Offline'));
		await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Offline'));
		expect(close).not.toHaveBeenCalled();
	});

	it('filters chats and rejects submission after capacity shrinks', async () => {
		const add = vi.fn(() => true);
		const close = vi.fn();
		const view = render(CanvasChatPicker, {
			chats: [chat],
			boxes: [],
			capacity: 1,
			onadd: add,
			onclose: close,
		});
		await fireEvent.input(screen.getByRole('searchbox'), { target: { value: 'architecture' } });
		await fireEvent.click(screen.getByRole('checkbox'));
		await view.rerender({ capacity: 0 });
		await fireEvent.submit(screen.getByRole('searchbox').closest('form')!);
		expect(add).not.toHaveBeenCalled();
		expect(close).not.toHaveBeenCalled();
		await view.rerender({ capacity: 1 });
		await fireEvent.submit(screen.getByRole('searchbox').closest('form')!);
		expect(add).toHaveBeenCalledExactlyOnceWith([chat.id], null);
		expect(close).toHaveBeenCalledOnce();
	});

	it('rejects self connections through keyboard submission', async () => {
		const connect = vi.fn(() => true);
		render(CanvasConnectionDialog, {
			nodes: canvasContent().nodes,
			chats: {},
			onconnect: connect,
			onclose: vi.fn(),
		});
		await fireEvent.change(screen.getByLabelText('From'), { target: { value: 'box-a' } });
		await fireEvent.change(screen.getByLabelText('To'), { target: { value: 'box-a' } });
		const form = screen.getByLabelText('From').closest('form')!;
		await fireEvent.submit(form);
		expect(connect).not.toHaveBeenCalled();
		await fireEvent.change(screen.getByLabelText('To'), { target: { value: 'box-b' } });
		await fireEvent.input(screen.getByLabelText('Connection label'), {
			target: { value: 'informs' },
		});
		expect(screen.getByLabelText<HTMLSelectElement>('From').value).toBe('box-a');
		expect(screen.getByLabelText<HTMLSelectElement>('To').value).toBe('box-b');
		expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Connect' }).disabled).toBe(false);
		await fireEvent.submit(form);
		expect(connect).toHaveBeenCalledExactlyOnceWith('box-a', 'box-b', 'informs');
	});

	it('rejects a selected chat removed from the live picker and keeps rejected additions open', async () => {
		const add = vi.fn(() => false);
		const close = vi.fn();
		const view = render(CanvasChatPicker, {
			chats: [chat],
			boxes: [],
			capacity: 1,
			onadd: add,
			onclose: close,
		});
		await fireEvent.click(screen.getByRole('checkbox'));
		await view.rerender({ chats: [] });
		expect(
			screen.getByRole<HTMLButtonElement>('button', { name: 'Add selected chats' }).disabled,
		).toBe(true);
		await fireEvent.submit(screen.getByRole('searchbox').closest('form')!);
		expect(add).not.toHaveBeenCalled();
		await view.rerender({ chats: [chat] });
		await fireEvent.submit(screen.getByRole('searchbox').closest('form')!);
		expect(add).toHaveBeenCalledExactlyOnceWith([chat.id], null);
		expect(close).not.toHaveBeenCalled();
	});

	it('preserves the connection label when capacity shrinks or submission is rejected', async () => {
		const connect = vi.fn(() => false);
		const close = vi.fn();
		const view = render(CanvasConnectionDialog, {
			nodes: canvasContent().nodes,
			chats: {},
			capacity: 1,
			initialSource: 'box-a',
			onconnect: connect,
			onclose: close,
		});
		await fireEvent.change(screen.getByLabelText('To'), { target: { value: 'box-b' } });
		await fireEvent.input(screen.getByLabelText('Connection label'), {
			target: { value: 'informs' },
		});
		await view.rerender({ capacity: 0 });
		expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Connect' }).disabled).toBe(true);
		await fireEvent.submit(screen.getByLabelText('From').closest('form')!);
		expect(connect).not.toHaveBeenCalled();
		await view.rerender({ capacity: 1 });
		await fireEvent.submit(screen.getByLabelText('From').closest('form')!);
		expect(connect).toHaveBeenCalledExactlyOnceWith('box-a', 'box-b', 'informs');
		expect(close).not.toHaveBeenCalled();
		expect(screen.getByLabelText<HTMLInputElement>('Connection label').value).toBe('informs');
	});

	it('suspends the name modal while hidden and restores its draft', async () => {
		const close = vi.fn();
		const view = render(CanvasNameDialog, {
			title: 'Rename box',
			onsubmit: () => true,
			onclose: close,
		});
		await fireEvent.input(screen.getByRole('textbox'), { target: { value: 'Unsubmitted title' } });
		await view.rerender({ visible: false });
		expect(screen.queryByRole('dialog')).toBeNull();
		await view.rerender({ visible: true });
		expect(screen.getByRole<HTMLInputElement>('textbox').value).toBe('Unsubmitted title');
		expect(close).not.toHaveBeenCalled();
	});

	it('suspends the picker modal while retaining query and selection', async () => {
		const close = vi.fn();
		const view = render(CanvasChatPicker, {
			chats: [chat],
			boxes: [],
			capacity: 1,
			onadd: () => true,
			onclose: close,
		});
		await fireEvent.input(screen.getByRole('searchbox'), { target: { value: 'Research' } });
		await fireEvent.click(screen.getByRole('checkbox'));
		await view.rerender({ visible: false });
		expect(screen.queryByRole('dialog')).toBeNull();
		await view.rerender({ visible: true });
		expect(screen.getByRole<HTMLInputElement>('searchbox').value).toBe('Research');
		expect(screen.getByRole<HTMLInputElement>('checkbox').checked).toBe(true);
		expect(close).not.toHaveBeenCalled();
	});

	it('suspends the connection modal while retaining endpoints and label', async () => {
		const close = vi.fn();
		const view = render(CanvasConnectionDialog, {
			nodes: canvasContent().nodes,
			chats: {},
			initialSource: 'box-a',
			onconnect: () => true,
			onclose: close,
		});
		await fireEvent.change(screen.getByLabelText('To'), { target: { value: 'box-b' } });
		await fireEvent.input(screen.getByLabelText('Connection label'), {
			target: { value: 'Unsubmitted label' },
		});
		await view.rerender({ visible: false });
		expect(screen.queryByRole('dialog')).toBeNull();
		await view.rerender({ visible: true });
		expect(screen.getByLabelText<HTMLSelectElement>('From').value).toBe('box-a');
		expect(screen.getByLabelText<HTMLSelectElement>('To').value).toBe('box-b');
		expect(screen.getByLabelText<HTMLInputElement>('Connection label').value).toBe(
			'Unsubmitted label',
		);
		expect(close).not.toHaveBeenCalled();
	});

	it('suspends the confirmation modal without interpreting it as cancellation', async () => {
		const close = vi.fn();
		const confirm = vi.fn(async () => true);
		const view = render(CanvasConfirmDialog, {
			title: 'Delete canvas',
			description: 'Delete this board?',
			onconfirm: confirm,
			onclose: close,
		});
		await view.rerender({ visible: false });
		expect(screen.queryByRole('dialog')).toBeNull();
		await view.rerender({ visible: true });
		expect(screen.getByRole('dialog')).toBeTruthy();
		expect(close).not.toHaveBeenCalled();
		expect(confirm).not.toHaveBeenCalled();
	});

	it('applies membership and protects label submission during reload', async () => {
		const document = new CanvasDocumentState(canvasContent(), vi.fn());
		const view = render(CanvasInspector, {
			document,
			chats: {},
			selectedIds: new Set(['chat-a']),
			disabled: false,
			onrename: vi.fn(),
			onopen: vi.fn(),
			onbeside: undefined,
			onclose: vi.fn(),
		});
		await fireEvent.change(screen.getByLabelText('Move to box'), { target: { value: 'box-b' } });
		expect(document.content.nodes.find((node) => node.id === 'chat-a')).toMatchObject({
			boxId: 'box-b',
		});
		document.undo();
		await tick();
		expect(screen.getByLabelText<HTMLSelectElement>('Move to box').value).toBe('box-a');
		await view.rerender({ selectedIds: new Set(['edge']), disabled: true });
		const input = screen.getByLabelText('Connection label');
		await fireEvent.submit(input.closest('form')!);
		expect(document.content.connections[0].label).toBe('implements');
	});
});
