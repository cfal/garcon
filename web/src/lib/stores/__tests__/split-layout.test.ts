import { describe, expect, it } from 'vitest';
import {
	SplitLayoutStore,
	createSplitLayoutStore,
	type LayoutNode,
	type PaneNode,
	type SplitNode,
} from '../split-layout.svelte';

function makeStore(): SplitLayoutStore {
	return new SplitLayoutStore();
}

function expectPane(node: LayoutNode | null, chatId: string): PaneNode {
	expect(node).toMatchObject({ type: 'pane', chatId });
	return node as PaneNode;
}

function expectSplit(node: LayoutNode | null, direction: SplitNode['direction']): SplitNode {
	expect(node).toMatchObject({ type: 'split', direction });
	return node as SplitNode;
}

function paneChats(store: SplitLayoutStore): string[] {
	return store.panes.map((pane) => pane.chatId);
}

function paneChatsFromNode(node: LayoutNode): string[] {
	if (node.type === 'pane') return [node.chatId];
	return [...paneChatsFromNode(node.children[0]), ...paneChatsFromNode(node.children[1])];
}

describe('SplitLayoutStore', () => {
	it('starts disabled and enables with one focused pane', () => {
		const store = makeStore();

		expect(store.isEnabled).toBe(false);
		expect(store.panes).toEqual([]);
		expect(store.paneCount).toBe(0);
		expect(store.focusedChatId).toBeNull();

		store.enableWithChat('chat-1');

		const pane = expectPane(store.root, 'chat-1');
		expect(store.isEnabled).toBe(true);
		expect(store.panes).toEqual([pane]);
		expect(store.paneCount).toBe(1);
		expect(store.focusedPaneId).toBe(pane.id);
		expect(store.focusedChatId).toBe('chat-1');
	});

	it('splits panes with explicit direction and before/after ordering', () => {
		const store = makeStore();
		store.enableWithChat('base');
		const basePaneId = store.panes[0].id;

		store.splitPane(basePaneId, 'horizontal', 'left', 'before');

		const root = expectSplit(store.root, 'horizontal');
		expect(paneChatsFromNode(root)).toEqual(['left', 'base']);
		expect(store.focusedChatId).toBe('left');

		const basePane = store.panes.find((pane) => pane.chatId === 'base');
		expect(basePane).toBeDefined();

		store.splitPane(basePane!.id, 'vertical', 'bottom', 'after');

		expect(paneChats(store)).toEqual(['left', 'base', 'bottom']);
		expect(store.focusedChatId).toBe('bottom');
		const nested = expectSplit(expectSplit(store.root, 'horizontal').children[1], 'vertical');
		expect(paneChatsFromNode(nested)).toEqual(['base', 'bottom']);
	});

	it('adds chats by drop zone and replaces on center drops', () => {
		const store = makeStore();
		store.enableWithChat('base');
		const basePaneId = store.panes[0].id;

		store.addChatToZone(basePaneId, 'left', 'left');

		const root = expectSplit(store.root, 'horizontal');
		expect(paneChatsFromNode(root)).toEqual(['left', 'base']);

		const basePane = store.panes.find((pane) => pane.chatId === 'base')!;
		store.addChatToZone(basePane.id, 'replacement', 'center');

		expect(paneChats(store)).toEqual(['left', 'replacement']);
		expect(store.focusedChatId).toBe('replacement');
	});

	it('does not split beyond four panes', () => {
		const store = makeStore();
		store.setGrid(['a', 'b', 'c', 'd']);
		const firstPaneId = store.panes[0].id;

		store.splitPane(firstPaneId, 'horizontal', 'e');

		expect(store.paneCount).toBe(4);
		expect(paneChats(store)).toEqual(['a', 'b', 'c', 'd']);
	});

	it('closes panes and collapses the layout tree', () => {
		const store = makeStore();
		store.setGrid(['a', 'b', 'c']);
		const focusedPaneId = store.focusedPaneId!;

		store.closePane(focusedPaneId);

		expect(store.isEnabled).toBe(true);
		expect(paneChats(store)).toEqual(['b', 'c']);
		expect(store.focusedChatId).toBe('b');

		const remainingPaneId = store.panes[0].id;
		store.closePane(remainingPaneId);

		expect(store.isEnabled).toBe(false);
		expect(store.root).toBeNull();
		expect(store.focusedPaneId).toBeNull();
	});

	it('clamps split ratios by path', () => {
		const store = makeStore();
		store.setGrid(['a', 'b', 'c', 'd']);

		store.setRatioByPath([], 0.95);
		expect(expectSplit(store.root, 'vertical').ratio).toBe(0.85);

		store.setRatioByPath([0], 0.05);
		expect(expectSplit(expectSplit(store.root, 'vertical').children[0], 'horizontal').ratio).toBe(
			0.15,
		);
	});

	it('tracks focus and drag state independently from layout contents', () => {
		const store = makeStore();
		store.setGrid(['a', 'b']);
		const [firstPane, secondPane] = store.panes;

		store.focusPane(secondPane.id);
		expect(store.focusedChatId).toBe('b');

		store.startDrag('external-chat');
		expect(store.draggedChatId).toBe('external-chat');
		expect(store.draggedPaneId).toBeNull();

		store.startPaneDrag(firstPane.id, 'a');
		expect(store.draggedChatId).toBe('a');
		expect(store.draggedPaneId).toBe(firstPane.id);

		store.endDrag();
		expect(store.draggedChatId).toBeNull();
		expect(store.draggedPaneId).toBeNull();
	});

	it('swaps pane chat assignments without changing pane ids', () => {
		const store = makeStore();
		store.setGrid(['a', 'b']);
		const [firstPane, secondPane] = store.panes;

		store.swapPanes(firstPane.id, secondPane.id);

		expect(store.panes.map((pane) => pane.id)).toEqual([firstPane.id, secondPane.id]);
		expect(paneChats(store)).toEqual(['b', 'a']);
	});

	it('creates stores through the factory', () => {
		expect(createSplitLayoutStore()).toBeInstanceOf(SplitLayoutStore);
	});
});
