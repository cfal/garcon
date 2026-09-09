import {
	parseCanvasContent,
	type CanvasContent,
	type CanvasConnection,
	type CanvasPosition,
} from '$shared/chat-canvas';
import {
	finishNodeMove,
	moveChat,
	nodePosition,
	removeCanvasElements,
	boxChats,
	CANVAS_BOX_WIDTH,
} from './canvas-layout.js';

const HISTORY_LIMIT = 50;

export class CanvasDocumentState {
	content: CanvasContent;
	#undo = $state.raw<CanvasContent[]>([]);
	#redo = $state.raw<CanvasContent[]>([]);

	constructor(
		content: CanvasContent,
		private readonly changed: (content: CanvasContent) => void,
	) {
		this.content = $state.raw(parseCanvasContent(content));
	}

	get canUndo(): boolean {
		return this.#undo.length > 0;
	}
	get canRedo(): boolean {
		return this.#redo.length > 0;
	}

	replace(content: CanvasContent): void {
		this.content = parseCanvasContent(content);
		this.#undo = [];
		this.#redo = [];
	}

	edit(content: CanvasContent): void {
		const next = parseCanvasContent(content);
		if (JSON.stringify(next) === JSON.stringify(this.content)) return;
		this.#undo = [...this.#undo.slice(-(HISTORY_LIMIT - 1)), this.content];
		this.#redo = [];
		this.content = next;
		this.changed(next);
	}

	undo(): void {
		const previous = this.#undo.at(-1);
		if (!previous) return;
		this.#redo = [...this.#redo, this.content];
		this.#undo = this.#undo.slice(0, -1);
		this.content = previous;
		this.changed(previous);
	}

	redo(): void {
		const next = this.#redo.at(-1);
		if (!next) return;
		this.#undo = [...this.#undo, this.content];
		this.#redo = this.#redo.slice(0, -1);
		this.content = next;
		this.changed(next);
	}

	rename(title: string): void {
		this.edit({ ...this.content, title: title.trim() });
	}

	addBox(title: string, position: CanvasPosition): string {
		const id = crypto.randomUUID();
		this.edit({
			...this.content,
			nodes: [...this.content.nodes, { id, type: 'box', title: title.trim(), position }],
		});
		return id;
	}

	addChats(chatIds: readonly string[], boxId: string | null, position: CanvasPosition): void {
		this.edit({
			...this.content,
			nodes: [
				...this.content.nodes,
				...chatIds.map((chatId, index) => ({
					id: crypto.randomUUID(),
					type: 'chat' as const,
					chatId,
					boxId,
					position: boxId
						? { x: 0, y: 0 }
						: {
								x: position.x + (index % 3) * (CANVAS_BOX_WIDTH + 24),
								y: position.y + Math.floor(index / 3) * 172,
							},
				})),
			],
		});
	}

	renameBox(id: string, title: string): void {
		this.edit({
			...this.content,
			nodes: this.content.nodes.map((node) =>
				node.id === id && node.type === 'box' ? { ...node, title: title.trim() } : node,
			),
		});
	}

	connect(connection: Omit<CanvasConnection, 'id'>): void {
		this.edit({
			...this.content,
			connections: [...this.content.connections, { ...connection, id: crypto.randomUUID() }],
		});
	}

	labelConnection(id: string, label: string): void {
		this.edit({
			...this.content,
			connections: this.content.connections.map((edge) =>
				edge.id === id ? { ...edge, label } : edge,
			),
		});
	}

	move(positions: ReadonlyMap<string, CanvasPosition>): void {
		this.edit(finishNodeMove(this.content, positions));
	}
	remove(ids: ReadonlySet<string>): void {
		this.edit(removeCanvasElements(this.content, ids));
	}

	moveToBox(id: string, boxId: string | null): void {
		const node = this.content.nodes.find((entry) => entry.id === id);
		if (!node) return;
		const position = nodePosition(this.content, node);
		this.edit(
			moveChat(this.content, id, boxId, { x: position.x + CANVAS_BOX_WIDTH + 24, y: position.y }),
		);
	}

	reorderChat(id: string, direction: -1 | 1): void {
		const node = this.content.nodes.find((entry) => entry.id === id);
		if (node?.type !== 'chat' || node.boxId === null) return;
		const siblings = boxChats(this.content, node.boxId);
		const index = siblings.findIndex((entry) => entry.id === id);
		const target = index + direction;
		if (target < 0 || target >= siblings.length) return;
		this.edit(moveChat(this.content, id, node.boxId, node.position, target));
	}
}
