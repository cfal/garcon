import { describe, expect, it, vi } from 'vitest';
import { CanvasDocumentState } from '../canvas-document.svelte';
import { canvasContent } from './canvas-fixtures';

describe('CanvasDocumentState', () => {
	it('shares one layout per content revision and refreshes through undo and replacement', () => {
		const document = new CanvasDocumentState(canvasContent(), () => {});
		const initial = document.layout;
		expect(document.layout).toBe(initial);
		expect(initial.chats('box-a')).toHaveLength(2);
		document.moveToBox('chat-a', 'box-b');
		expect(document.layout).not.toBe(initial);
		expect(document.layout.chats('box-a')).toHaveLength(1);
		expect(initial.chats('box-a')).toHaveLength(2);
		document.undo();
		expect(document.layout.chats('box-a')).toHaveLength(2);
		document.redo();
		expect(document.layout.chats('box-b')).toHaveLength(1);
		document.replace(canvasContent());
		expect(document.layout.chats('box-b')).toHaveLength(0);
	});

	it('records membership and geometry as single reversible edits', () => {
		const changed = vi.fn();
		const document = new CanvasDocumentState(canvasContent(), changed);
		document.moveToBox('chat-a', 'box-b');
		expect(document.canUndo).toBe(true);
		document.undo();
		expect(document.content).toEqual(canvasContent());
		document.redo();
		expect(document.content.nodes.find((node) => node.id === 'chat-a')).toMatchObject({
			boxId: 'box-b',
		});
		expect(changed).toHaveBeenCalledTimes(3);
	});

	it('supports duplicate chat references, labels, and box removal without deleting chats', () => {
		const document = new CanvasDocumentState(canvasContent(), () => {});
		document.addChats(['1780000000000001'], 'box-b', { x: 0, y: 0 });
		expect(
			document.content.nodes.filter(
				(node) => node.type === 'chat' && node.chatId === '1780000000000001',
			),
		).toHaveLength(2);
		document.labelConnection('edge', 'Depends on');
		expect(document.content.connections[0].label).toBe('Depends on');
		document.remove(new Set(['box-a']));
		expect(document.content.nodes.filter((node) => node.type === 'chat')).toHaveLength(3);
		document.undo();
		expect(document.content.nodes.some((node) => node.id === 'box-a')).toBe(true);
	});

	it('ignores no-op edits, clears redo on new edits, and resets history on remote replacement', () => {
		const changed = vi.fn();
		const document = new CanvasDocumentState(canvasContent(), changed);
		document.rename('Work');
		expect(changed).not.toHaveBeenCalled();
		document.rename('New');
		document.undo();
		document.rename('Another');
		expect(document.canRedo).toBe(false);
		document.replace(canvasContent());
		expect(document.canUndo).toBe(false);
	});
});
