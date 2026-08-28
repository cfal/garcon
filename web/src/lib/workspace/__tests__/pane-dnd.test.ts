import { afterEach, describe, expect, it } from 'vitest';
import { createWorkspaceLayoutStore, reduceWorkspaceLayout } from '../workspace-layout.svelte.js';
import { WorkspacePaneDndStore } from '../pane-dnd.svelte.js';
import { portableSingletonDescriptor, type PaneId } from '../surface-types.js';

function dragEvent(
	type: string,
	currentTarget: HTMLElement,
	options: { clientX?: number; clientY?: number } = {},
): DragEvent {
	const event = new DragEvent(type, {
		bubbles: true,
		cancelable: true,
		clientX: options.clientX ?? 0,
		clientY: options.clientY ?? 0,
		dataTransfer: new DataTransfer(),
	});
	Object.defineProperty(event, 'currentTarget', { value: currentTarget });
	Object.defineProperty(event, 'clientX', { value: options.clientX ?? 0 });
	Object.defineProperty(event, 'clientY', { value: options.clientY ?? 0 });
	return event;
}

function paneElement(paneId: PaneId): HTMLElement {
	const element = document.createElement('div');
	element.dataset.workspacePaneId = paneId;
	element.getBoundingClientRect = () => new DOMRect(0, 0, 100, 100);
	document.body.append(element);
	return element;
}

function splitLayout() {
	const layout = createWorkspaceLayoutStore();
	layout.publish(
		layout.revision,
		reduceWorkspaceLayout(layout.snapshot, [
			{
				type: 'register-surface-in-split',
				surface: portableSingletonDescriptor('files'),
				targetPaneId: 'pane-main',
				edge: 'right',
				newPaneId: 'pane-files',
				splitId: 'split-files',
			},
		]),
	);
	return layout;
}

afterEach(() => {
	document.body.replaceChildren();
});

describe('WorkspacePaneDndStore', () => {
	it('returns the surface and pane destination atomically before clearing drag state', () => {
		const layout = splitLayout();
		const dnd = new WorkspacePaneDndStore(layout);
		const source = paneElement('pane-main');
		const destination = paneElement('pane-files');
		dnd.startTabDrag('singleton:git', 'pane-main', dragEvent('dragstart', source));
		dnd.handlePaneDragOver(
			'pane-files',
			dragEvent('dragover', destination, { clientX: 50, clientY: 50 }),
		);

		const commit = dnd.handlePaneDrop(
			'pane-files',
			dragEvent('drop', destination, { clientX: 50, clientY: 50 }),
		);

		expect(commit).toMatchObject({
			surfaceId: 'singleton:git',
			target: { kind: 'pane', paneId: 'pane-files', zone: 'center' },
		});
		expect(dnd.draggedSurfaceId).toBeNull();
		expect(dnd.activeTarget).toBeNull();
	});

	it('blocks an edge split of the sole tab back into its own pane', () => {
		const layout = splitLayout();
		const dnd = new WorkspacePaneDndStore(layout);
		const filesPane = paneElement('pane-files');
		dnd.startTabDrag('singleton:files', 'pane-files', dragEvent('dragstart', filesPane));

		dnd.handlePaneDragOver(
			'pane-files',
			dragEvent('dragover', filesPane, { clientX: 5, clientY: 50 }),
		);

		expect(dnd.activeTarget).toMatchObject({
			kind: 'pane',
			zone: 'left',
			blockedReason: 'same-pane',
		});
		expect(
			dnd.handlePaneDrop(
				'pane-files',
				dragEvent('drop', filesPane, { clientX: 5, clientY: 50 }),
			),
		).toBeNull();
	});

	it('resolves tab-strip drops to an index in the destination order', () => {
		const layout = createWorkspaceLayoutStore();
		const dnd = new WorkspacePaneDndStore(layout);
		const source = paneElement('pane-main');
		const pullRequestsTab = document.createElement('button');
		pullRequestsTab.getBoundingClientRect = () => new DOMRect(100, 0, 80, 32);
		document.body.append(pullRequestsTab);
		dnd.startTabDrag('singleton:git', 'pane-main', dragEvent('dragstart', source));
		dnd.handleTabDragOver(
			'pane-main',
			'singleton:pull-requests',
			dragEvent('dragover', pullRequestsTab, { clientX: 175, clientY: 16 }),
		);

		const commit = dnd.handleTabDrop(
			'pane-main',
			'singleton:pull-requests',
			dragEvent('drop', pullRequestsTab, { clientX: 175, clientY: 16 }),
		);

		expect(commit).toEqual({
			surfaceId: 'singleton:git',
			target: {
				kind: 'tab',
				paneId: 'pane-main',
				index: 2,
				referenceSurfaceId: 'singleton:pull-requests',
				position: 'after',
			},
		});
	});
});
