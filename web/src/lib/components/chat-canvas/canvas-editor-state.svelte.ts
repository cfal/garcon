import type { CanvasDocumentState } from '$lib/chat-canvas/canvas-document.svelte';
import { nodePosition } from '$lib/chat-canvas/canvas-layout';

export class CanvasEditorState {
	selectedIds = $state<ReadonlySet<string>>(new Set());
	query = $state('');
	touchEditing = $state(false);
	error = $state<string | null>(null);
	dialog = $state<
		| { kind: 'box' }
		| { kind: 'rename-box'; id: string; title: string }
		| { kind: 'chats'; boxId: string }
		| { kind: 'connect' }
		| null
	>(null);

	constructor(
		private readonly options: {
			readonly document: CanvasDocumentState;
			readonly disabled: boolean;
		},
	) {}

	select(ids: ReadonlySet<string>): void {
		this.selectedIds = ids;
	}
	reconcile(): void {
		const content = this.options.document.content;
		const valid = new Set([
			...content.nodes.map((node) => node.id),
			...content.connections.map((edge) => edge.id),
		]);
		const next = new Set([...this.selectedIds].filter((id) => valid.has(id)));
		if (next.size !== this.selectedIds.size) this.selectedIds = next;
	}

	keydown(event: KeyboardEvent): void {
		if (this.options.disabled || this.dialog || event.defaultPrevented || event.isComposing) return;
		if (
			event.target instanceof HTMLElement &&
			event.target.closest('input,textarea,select,[contenteditable="true"]')
		)
			return;
		const document = this.options.document;
		const command = event.metaKey || event.ctrlKey;
		if (
			(event.key === 'Enter' || event.key === ' ') &&
			event.target instanceof HTMLElement &&
			event.target.matches('.svelte-flow__node[data-id]')
		) {
			const id = event.target.dataset.id!;
			this.selectedIds = new Set(event.shiftKey ? [...this.selectedIds, id] : [id]);
		} else if (command && event.key.toLowerCase() === 'z') {
			if (event.shiftKey) document.redo();
			else document.undo();
		} else if (command && event.key.toLowerCase() === 'y') document.redo();
		else if (command && event.key.toLowerCase() === 'a')
			this.selectedIds = new Set(document.content.nodes.map((node) => node.id));
		else if (event.key === 'Delete' || event.key === 'Backspace') {
			document.remove(this.selectedIds);
			this.selectedIds = new Set();
		} else if (event.key === 'Escape') this.selectedIds = new Set();
		else if (
			['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key) &&
			this.selectedIds.size
		) {
			const distance = event.shiftKey ? 50 : 10;
			const dx = event.key === 'ArrowLeft' ? -distance : event.key === 'ArrowRight' ? distance : 0;
			const dy = event.key === 'ArrowUp' ? -distance : event.key === 'ArrowDown' ? distance : 0;
			const positions = new Map<string, { x: number; y: number }>();
			for (const node of document.content.nodes) {
				if (!this.selectedIds.has(node.id)) continue;
				const point = nodePosition(document.content, node);
				positions.set(node.id, { x: point.x + dx, y: point.y + dy });
			}
			document.move(positions);
		} else return;
		event.preventDefault();
		event.stopPropagation();
	}
}
