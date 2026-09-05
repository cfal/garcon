import { afterEach, describe, expect, it } from 'vitest';
import { createWorkspaceLayoutStore, reduceWorkspaceLayout } from '../workspace-layout.svelte.js';
import {
	resolveWorkspaceWindowCenterDropResult,
	WorkspaceWindowDndController,
} from '../window-dnd.svelte.js';
import {
	portableSingletonDescriptor,
	type WorkspacePartitionId,
	type WorkspaceWindowId,
} from '../surface-types.js';
import { resolveUnmeasuredWorkspaceSplit } from './workspace-geometry-test-fixtures.js';

function dragEvent(
	type: string,
	currentTarget: HTMLElement,
	options: { clientX?: number; clientY?: number; relatedTarget?: EventTarget | null } = {},
): DragEvent {
	const event = new DragEvent(type, {
		bubbles: true,
		cancelable: true,
		dataTransfer: new DataTransfer(),
	});
	Object.defineProperties(event, {
		clientX: { value: options.clientX ?? 0 },
		clientY: { value: options.clientY ?? 0 },
		...('relatedTarget' in options ? { relatedTarget: { value: options.relatedTarget } } : {}),
	});
	Object.defineProperty(event, 'currentTarget', { value: currentTarget });
	return event;
}

function windowElement(windowId: WorkspaceWindowId): HTMLElement {
	const element = document.createElement('div');
	element.dataset.workspaceWindowId = windowId;
	element.getBoundingClientRect = () =>
		({
			x: 0,
			y: 0,
			left: 0,
			top: 0,
			right: 100,
			bottom: 100,
			width: 100,
			height: 100,
			toJSON: () => ({}),
		}) as DOMRect;
	document.body.append(element);
	return element;
}

function twoWindowLayout() {
	const layout = createWorkspaceLayoutStore();
	layout.publish(
		layout.revision,
		reduceWorkspaceLayout(layout.snapshot, [
			{
				type: 'register-surface',
				surface: portableSingletonDescriptor('git'),
				windowId: 'window-main',
			},
		]),
	);
	return layout;
}

afterEach(() => {
	document.body.replaceChildren();
});

describe('WorkspaceWindowDndController', () => {
	it('returns a surface move and center destination before clearing drag state', () => {
		const layout = twoWindowLayout();
		const dnd = new WorkspaceWindowDndController(layout, resolveUnmeasuredWorkspaceSplit);
		const source = windowElement('window-main');
		const destination = windowElement('window-files');
		dnd.beginSurfaceTabDrag('singleton:git', 'window-main', 1, dragEvent('dragstart', source));
		dnd.handleWindowDragOver(
			'window-files',
			dragEvent('dragover', destination, { clientX: 50, clientY: 50 }),
		);

		expect(
			dnd.handleWindowDrop(
				'window-files',
				dragEvent('drop', destination, { clientX: 50, clientY: 50 }),
			),
		).toMatchObject({
			payload: { kind: 'surface-tab', surfaceId: 'singleton:git' },
			target: { kind: 'window', windowId: 'window-files', zone: 'center' },
		});
		expect(dnd.payload).toBeNull();
		expect(dnd.activeTarget).toBeNull();
	});

	it('classifies Chat center drops by destination ownership', () => {
		const chatlessDestination = twoWindowLayout();
		const surfacePayload = {
			kind: 'surface-tab',
			surfaceId: 'chat-view:window-main',
			sourceWindowId: 'window-main',
			sourceIndex: 0,
		} as const;
		expect(
			resolveWorkspaceWindowCenterDropResult(
				chatlessDestination.snapshot,
				surfacePayload,
				'window-files',
			),
		).toBe('add-tab');
		expect(
			resolveWorkspaceWindowCenterDropResult(
				chatlessDestination.snapshot,
				{ kind: 'chat', chatId: 'chat-c', source: 'chat-list' },
				'window-files',
			),
		).toBe('add-tab');

		const occupiedDestination = createWorkspaceLayoutStore();
		occupiedDestination.publish(
			occupiedDestination.revision,
			reduceWorkspaceLayout(occupiedDestination.snapshot, [
				{ type: 'set-window-chat', windowId: 'window-main', chatId: 'chat-a' },
				{
					type: 'open-chat-in-new-window',
					chatId: 'chat-b',
					targetWindowId: 'window-main',
					edge: 'right',
					newWindowId: 'window-chat',
					partitionId: 'partition-chat',
				},
			]),
		);
		expect(
			resolveWorkspaceWindowCenterDropResult(
				occupiedDestination.snapshot,
				surfacePayload,
				'window-chat',
			),
		).toBe('replace-chat');
		expect(
			resolveWorkspaceWindowCenterDropResult(
				occupiedDestination.snapshot,
				{ kind: 'chat', chatId: 'chat-c', source: 'chat-list' },
				'window-chat',
			),
		).toBe('replace-chat');
	});

	it('blocks opening the sole tab from a window beside itself', () => {
		const layout = twoWindowLayout();
		const dnd = new WorkspaceWindowDndController(layout, resolveUnmeasuredWorkspaceSplit);
		const filesWindow = windowElement('window-files');
		dnd.beginSurfaceTabDrag(
			'singleton:files',
			'window-files',
			0,
			dragEvent('dragstart', filesWindow),
		);
		dnd.handleWindowDragOver(
			'window-files',
			dragEvent('dragover', filesWindow, { clientX: 5, clientY: 50 }),
		);

		expect(dnd.activeTarget).toMatchObject({
			kind: 'window',
			zone: 'left',
			blockedReason: 'same-window',
		});
	});

	it('maps a sidebar Chat drag to the center target', () => {
		const layout = createWorkspaceLayoutStore();
		const dnd = new WorkspaceWindowDndController(layout, resolveUnmeasuredWorkspaceSplit);
		const target = windowElement('window-main');
		dnd.beginChatDrag('chat-a');
		dnd.handleWindowDragOver(
			'window-main',
			dragEvent('dragover', target, { clientX: 50, clientY: 50 }),
		);

		expect(dnd.activeTarget).toEqual({
			kind: 'window',
			windowId: 'window-main',
			zone: 'center',
			blockedReason: undefined,
		});
		expect(
			dnd.handleWindowDrop('window-main', dragEvent('drop', target, { clientX: 50, clientY: 50 })),
		).toMatchObject({
			payload: { kind: 'chat', chatId: 'chat-a' },
			target: { kind: 'window', windowId: 'window-main', zone: 'center' },
		});
	});

	it('blocks Chat edges but keeps the center available at the resource ceiling', () => {
		const layout = createWorkspaceLayoutStore();
		layout.publish(
			layout.revision,
			reduceWorkspaceLayout(layout.snapshot, [
				...(
					['git', 'commit', 'git-history', 'git-compare', 'chat-map', 'pull-requests'] as const
				).map((kind, index) => ({
					type: 'register-surface-in-new-window' as const,
					surface: portableSingletonDescriptor(kind),
					targetWindowId: 'window-main' as const,
					edge: 'right' as const,
					newWindowId: `window-${index + 2}` as WorkspaceWindowId,
					partitionId: `partition-${index + 2}` as WorkspacePartitionId,
				})),
			]),
		);
		const dnd = new WorkspaceWindowDndController(layout, resolveUnmeasuredWorkspaceSplit);
		const target = windowElement('window-main');
		dnd.beginChatDrag('chat-a');
		dnd.handleWindowDragOver(
			'window-main',
			dragEvent('dragover', target, { clientX: 5, clientY: 50 }),
		);

		expect(dnd.activeTarget).toMatchObject({ blockedReason: 'resource-ceiling' });
		dnd.handleWindowDragOver(
			'window-main',
			dragEvent('dragover', target, { clientX: 50, clientY: 50 }),
		);
		expect(dnd.activeTarget).toEqual({
			kind: 'window',
			windowId: 'window-main',
			zone: 'center',
			blockedReason: undefined,
		});
	});

	it('preserves edge-specific admission while leaving center drops available', () => {
		const layout = createWorkspaceLayoutStore();
		const dnd = new WorkspaceWindowDndController(layout, (_snapshot, request) =>
			request.edge === 'top' ? { allowed: true } : { allowed: false, reason: 'too-small' },
		);
		const target = windowElement('window-main');
		dnd.beginChatDrag('chat-a');

		dnd.handleWindowDragOver(
			'window-main',
			dragEvent('dragover', target, { clientX: 5, clientY: 50 }),
		);
		expect(dnd.activeTarget).toMatchObject({ zone: 'left', blockedReason: 'too-small' });

		dnd.handleWindowDragOver(
			'window-main',
			dragEvent('dragover', target, { clientX: 50, clientY: 5 }),
		);
		expect(dnd.activeTarget).toMatchObject({ zone: 'top', blockedReason: undefined });

		dnd.handleWindowDragOver(
			'window-main',
			dragEvent('dragover', target, { clientX: 50, clientY: 50 }),
		);
		expect(dnd.activeTarget).toMatchObject({ zone: 'center', blockedReason: undefined });
	});

	it('removes stale edge targets when admission is inapplicable', () => {
		const layout = createWorkspaceLayoutStore();
		const dnd = new WorkspaceWindowDndController(layout, () => null);
		const target = windowElement('window-main');
		const event = dragEvent('dragover', target, { clientX: 5, clientY: 50 });
		dnd.beginChatDrag('chat-a');

		dnd.handleWindowDragOver('window-main', event);

		expect(dnd.activeTarget).toBeNull();
	});

	it('keeps the active target when a null dragleave target remains inside the window', () => {
		const layout = createWorkspaceLayoutStore();
		const dnd = new WorkspaceWindowDndController(layout, resolveUnmeasuredWorkspaceSplit);
		const target = windowElement('window-main');
		dnd.beginChatDrag('chat-a');
		dnd.handleWindowDragOver(
			'window-main',
			dragEvent('dragover', target, { clientX: 50, clientY: 50 }),
		);

		dnd.handleWindowDragLeave(
			dragEvent('dragleave', target, {
				clientX: 50,
				clientY: 50,
				relatedTarget: null,
			}),
		);

		expect(dnd.activeTarget).toMatchObject({ kind: 'window', windowId: 'window-main' });
	});

	it('clears the active target when a null dragleave target is outside the window', () => {
		const layout = createWorkspaceLayoutStore();
		const dnd = new WorkspaceWindowDndController(layout, resolveUnmeasuredWorkspaceSplit);
		const target = windowElement('window-main');
		dnd.beginChatDrag('chat-a');
		dnd.handleWindowDragOver(
			'window-main',
			dragEvent('dragover', target, { clientX: 50, clientY: 50 }),
		);

		dnd.handleWindowDragLeave(
			dragEvent('dragleave', target, {
				clientX: 110,
				clientY: 50,
				relatedTarget: null,
			}),
		);

		expect(dnd.activeTarget).toBeNull();
	});

	it('resolves tab-strip drops to an exact destination index', () => {
		const layout = twoWindowLayout();
		const dnd = new WorkspaceWindowDndController(layout, resolveUnmeasuredWorkspaceSplit);
		const source = windowElement('window-main');
		const chatTab = document.createElement('button');
		chatTab.getBoundingClientRect = () => new DOMRect(100, 0, 80, 32);
		document.body.append(chatTab);
		dnd.beginSurfaceTabDrag('singleton:git', 'window-main', 1, dragEvent('dragstart', source));
		dnd.handleTabDragOver(
			'window-main',
			'chat-view:window-main',
			dragEvent('dragover', chatTab, { clientX: 105, clientY: 16 }),
		);

		expect(
			dnd.handleTabDrop(
				'window-main',
				'chat-view:window-main',
				dragEvent('drop', chatTab, { clientX: 105, clientY: 16 }),
			),
		).toMatchObject({
			payload: { surfaceId: 'singleton:git' },
			target: { kind: 'tab', windowId: 'window-main', index: 0, position: 'before' },
		});
	});

	it('writes only an opaque marker to native transfer data', () => {
		const layout = twoWindowLayout();
		const dnd = new WorkspaceWindowDndController(layout, resolveUnmeasuredWorkspaceSplit);
		const event = dragEvent('dragstart', windowElement('window-main'));
		dnd.beginSurfaceTabDrag('singleton:git', 'window-main', 1, event);

		const serialized = Array.from(event.dataTransfer?.types ?? [])
			.map((type) => event.dataTransfer?.getData(type) ?? '')
			.join('|');
		expect(serialized).not.toContain('singleton:git');
		expect(serialized).not.toContain('window-main');
	});
});
