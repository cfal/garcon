import { afterEach, describe, expect, it } from 'vitest';
import { createWorkspaceLayoutStore, reduceWorkspaceLayout } from '../workspace-layout.svelte.js';
import { WorkspaceWindowDndController } from '../window-dnd.svelte.js';
import {
	portableSingletonDescriptor,
	type WorkspacePartitionId,
	type WorkspaceWindowId,
} from '../surface-types.js';

function dragEvent(
	type: string,
	currentTarget: HTMLElement,
	options: { clientX?: number; clientY?: number } = {},
): DragEvent {
	const event = new DragEvent(type, {
		bubbles: true,
		cancelable: true,
		dataTransfer: new DataTransfer(),
	});
	Object.defineProperties(event, {
		clientX: { value: options.clientX ?? 0 },
		clientY: { value: options.clientY ?? 0 },
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
			{
				type: 'register-surface-in-new-window',
				surface: portableSingletonDescriptor('files'),
				targetWindowId: 'window-main',
				edge: 'right',
				newWindowId: 'window-files',
				partitionId: 'partition-files',
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
		const dnd = new WorkspaceWindowDndController(layout);
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

	it('blocks opening the sole tab from a window beside itself', () => {
		const layout = twoWindowLayout();
		const dnd = new WorkspaceWindowDndController(layout);
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

	it('maps a chat center tie to a new right-hand window', () => {
		const layout = createWorkspaceLayoutStore();
		const dnd = new WorkspaceWindowDndController(layout);
		const target = windowElement('window-main');
		dnd.beginChatDrag('chat-a');
		dnd.handleWindowDragOver(
			'window-main',
			dragEvent('dragover', target, { clientX: 50, clientY: 50 }),
		);

		expect(dnd.activeTarget).toEqual({
			kind: 'window',
			windowId: 'window-main',
			zone: 'right',
			blockedReason: undefined,
		});
	});

	it('blocks every chat drop target at the four-window cap', () => {
		const layout = createWorkspaceLayoutStore();
		layout.publish(
			layout.revision,
			reduceWorkspaceLayout(layout.snapshot, [
				...(['git', 'files', 'commit'] as const).map((kind, index) => ({
					type: 'register-surface-in-new-window' as const,
					surface: portableSingletonDescriptor(kind),
					targetWindowId: 'window-main' as const,
					edge: 'right' as const,
					newWindowId: `window-${index + 2}` as WorkspaceWindowId,
					partitionId: `partition-${index + 2}` as WorkspacePartitionId,
				})),
			]),
		);
		const dnd = new WorkspaceWindowDndController(layout);
		const target = windowElement('window-main');
		dnd.beginChatDrag('chat-a');
		dnd.handleWindowDragOver(
			'window-main',
			dragEvent('dragover', target, { clientX: 5, clientY: 50 }),
		);

		expect(dnd.activeTarget).toMatchObject({ blockedReason: 'max-windows' });
	});

	it('resolves tab-strip drops to an exact destination index', () => {
		const layout = twoWindowLayout();
		const dnd = new WorkspaceWindowDndController(layout);
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
		const dnd = new WorkspaceWindowDndController(layout);
		const event = dragEvent('dragstart', windowElement('window-main'));
		dnd.beginSurfaceTabDrag('singleton:git', 'window-main', 1, event);

		const serialized = Array.from(event.dataTransfer?.types ?? [])
			.map((type) => event.dataTransfer?.getData(type) ?? '')
			.join('|');
		expect(serialized).not.toContain('singleton:git');
		expect(serialized).not.toContain('window-main');
	});
});
