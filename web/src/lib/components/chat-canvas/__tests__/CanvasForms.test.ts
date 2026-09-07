import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import { CanvasDocumentState } from '$lib/chat-canvas/canvas-document.svelte';
import { canvasContent, deferred } from '$lib/chat-canvas/__tests__/canvas-fixtures';
import CanvasNameDialog from '../CanvasNameDialog.svelte';
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
		const add = vi.fn();
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
		const connect = vi.fn();
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
