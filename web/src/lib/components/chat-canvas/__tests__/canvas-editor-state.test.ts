import { describe, expect, it, vi } from 'vitest';
import { CanvasEditorState } from '../canvas-editor-state.svelte';
import { CanvasDocumentState } from '$lib/chat-canvas/canvas-document.svelte';
import { CanvasLayoutIndex } from '$lib/chat-canvas/canvas-layout';
import { canvasContent } from '$lib/chat-canvas/__tests__/canvas-fixtures';

function setup() {
	const document = new CanvasDocumentState(canvasContent(), vi.fn());
	let disabled = false;
	const editor = new CanvasEditorState({
		document,
		get disabled() {
			return disabled;
		},
	});
	return {
		document,
		editor,
		disable: () => {
			disabled = true;
		},
	};
}

function press(
	editor: CanvasEditorState,
	element: HTMLElement,
	key: string,
	options: KeyboardEventInit = {},
) {
	const listener = (event: KeyboardEvent) => editor.keydown(event);
	element.addEventListener('keydown', listener);
	const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
	element.dispatchEvent(event);
	element.removeEventListener('keydown', listener);
	return event;
}

describe('canvas keyboard ownership', () => {
	it('shares one layout when nudging all 1,000 detached cards', () => {
		const nodes = Array.from({ length: 1_000 }, (_, index) => ({
			id: `node-${index}`, type: 'chat' as const, chatId: `${1780000000000000 + index}`,
			boxId: null, position: { x: index * 400, y: 0 },
		}));
		const canvas = new CanvasDocumentState({ title: 'Synthetic', nodes, connections: [] }, vi.fn());
		const editor = new CanvasEditorState({ document: canvas, disabled: false });
		const target = document.createElement('div');
		press(editor, target, 'a', { ctrlKey: true });
		const position = vi.spyOn(CanvasLayoutIndex.prototype, 'position');
		try {
			expect(press(editor, target, 'ArrowRight').defaultPrevented).toBe(true);
			expect(position).toHaveBeenCalledTimes(nodes.length);
			expect(new Set(position.mock.contexts).size).toBe(1);
			expect(canvas.content.nodes.map(node => node.position)).toEqual(
				nodes.map(node => ({ x: node.position.x + 10, y: 0 })),
			);
			canvas.undo();
			expect(canvas.content.nodes).toEqual(nodes);
		} finally {
			position.mockRestore();
		}
	});

	it('selects focused nodes and supports removing and undoing placements', () => {
		const { document: canvas, editor } = setup();
		const node = document.createElement('div');
		node.className = 'svelte-flow__node';
		node.dataset.id = 'chat-a';
		expect(press(editor, node, 'Enter').defaultPrevented).toBe(true);
		expect(editor.selectedIds.has('chat-a')).toBe(true);
		press(editor, node, 'Delete');
		expect(canvas.content.nodes.some((entry) => entry.id === 'chat-a')).toBe(false);
		press(editor, node, 'z', { ctrlKey: true });
		expect(canvas.content.nodes.some((entry) => entry.id === 'chat-a')).toBe(true);
	});

	it('leaves editable controls, composition, dialogs, and disabled editors alone', () => {
		const { document: canvas, editor, disable } = setup();
		canvas.rename('Changed');
		const input = document.createElement('input');
		expect(press(editor, input, 'z', { ctrlKey: true }).defaultPrevented).toBe(false);
		const button = document.createElement('button');
		expect(press(editor, button, 'z', { ctrlKey: true, isComposing: true }).defaultPrevented).toBe(
			false,
		);
		editor.dialog = { kind: 'box' };
		expect(press(editor, button, 'z', { ctrlKey: true }).defaultPrevented).toBe(false);
		editor.dialog = null;
		disable();
		expect(press(editor, button, 'z', { ctrlKey: true }).defaultPrevented).toBe(false);
		expect(canvas.content.title).toBe('Changed');
	});
});
