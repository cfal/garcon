import type {
	CanvasBox,
	CanvasChat,
	CanvasContent,
	CanvasNode,
	CanvasPosition,
} from '$shared/chat-canvas';

export const CANVAS_CARD_WIDTH = 300;
export const CANVAS_CARD_HEIGHT = 132;
export const CANVAS_BOX_PADDING = 16;
export const CANVAS_BOX_HEADER = 52;
export const CANVAS_CHAT_GAP = 12;
export const CANVAS_BOX_WIDTH = CANVAS_CARD_WIDTH + CANVAS_BOX_PADDING * 2;

export interface CanvasBounds extends CanvasPosition {
	width: number;
	height: number;
}

export function boxChats(content: CanvasContent, boxId: string | null): CanvasChat[] {
	return content.nodes.filter(
		(node): node is CanvasChat => node.type === 'chat' && node.boxId === boxId,
	);
}

export function boxAt(content: CanvasContent, point: CanvasPosition): CanvasBox | null {
	return new CanvasLayoutIndex(content).boxAt(point);
}

export class CanvasLayoutIndex {
	readonly byId = new Map<string, CanvasNode>();
	readonly #children = new Map<string | null, CanvasChat[]>();
	readonly #ranks = new Map<string, number>();
	readonly #boxes: CanvasBox[] = [];

	constructor(content: CanvasContent) {
		for (const node of content.nodes) {
			this.byId.set(node.id, node);
			if (node.type === 'box') {
				this.#boxes.push(node);
			} else {
				let children = this.#children.get(node.boxId);
				if (!children) {
					children = [];
					this.#children.set(node.boxId, children);
				}
				this.#ranks.set(node.id, children.length);
				children.push(node);
			}
		}
	}

	chats(boxId: string | null): readonly CanvasChat[] {
		return this.#children.get(boxId) ?? [];
	}

	bounds(box: CanvasBox): CanvasBounds {
		const count = this.#children.get(box.id)?.length ?? 0;
		return {
			...box.position,
			width: CANVAS_BOX_WIDTH,
			height:
				CANVAS_BOX_HEADER +
				Math.max(1, count) * (CANVAS_CARD_HEIGHT + CANVAS_CHAT_GAP) +
				CANVAS_BOX_PADDING -
				CANVAS_CHAT_GAP,
		};
	}

	position(node: CanvasNode): CanvasPosition {
		if (node.type === 'box' || node.boxId === null) return node.position;
		const box = this.byId.get(node.boxId);
		if (!box) return node.position;
		return {
			x: box.position.x + CANVAS_BOX_PADDING,
			y: box.position.y + CANVAS_BOX_HEADER +
				(this.#ranks.get(node.id) ?? -1) * (CANVAS_CARD_HEIGHT + CANVAS_CHAT_GAP),
		};
	}

	boxAt(point: CanvasPosition): CanvasBox | null {
		for (let index = this.#boxes.length - 1; index >= 0; index--) {
			const box = this.#boxes[index]!;
			const bounds = this.bounds(box);
			if (
				point.x >= bounds.x &&
				point.x <= bounds.x + bounds.width &&
				point.y >= bounds.y &&
				point.y <= bounds.y + bounds.height
			) return box;
		}
		return null;
	}
}

export function moveChat(
	content: CanvasContent,
	id: string,
	boxId: string | null,
	position: CanvasPosition,
	index?: number,
): CanvasContent {
	const chat = content.nodes.find((node) => node.id === id);
	if (
		chat?.type !== 'chat' ||
		(boxId !== null && !content.nodes.some((node) => node.id === boxId && node.type === 'box'))
	)
		return content;
	const nodes = content.nodes.filter((node) => node.id !== id);
	const siblings = nodes.filter((node) => node.type === 'chat' && node.boxId === boxId);
	const before = index === undefined ? undefined : siblings[Math.max(0, index)];
	const insertAt = before ? nodes.indexOf(before) : nodes.length;
	nodes.splice(insertAt, 0, { ...chat, boxId, position: boxId ? { x: 0, y: 0 } : position });
	return { ...content, nodes };
}

export function finishNodeMove(
	content: CanvasContent,
	positions: ReadonlyMap<string, CanvasPosition>,
): CanvasContent {
	const movedBoxes = new Set(
		content.nodes
			.filter((node) => node.type === 'box' && positions.has(node.id))
			.map((node) => node.id),
	);
	const geometry = {
		...content,
		nodes: content.nodes.map((node) =>
			node.type === 'box' && positions.has(node.id)
				? { ...node, position: positions.get(node.id)! }
				: node,
		),
	};
	const layout = new CanvasLayoutIndex(geometry);
	const moves = new Map<string, { chat: CanvasChat; index: number }>();
	for (const node of content.nodes) {
		const position = positions.get(node.id);
		if (!position || node.type !== 'chat' || (node.boxId && movedBoxes.has(node.boxId))) continue;
		const box = layout.boxAt({
			x: position.x + CANVAS_CARD_WIDTH / 2,
			y: position.y + CANVAS_CARD_HEIGHT / 2,
		});
		moves.set(node.id, {
			chat: { ...node, boxId: box?.id ?? null, position: box ? { x: 0, y: 0 } : position },
			index: box
				? Math.max(
						0,
						Math.round(
							(position.y - box.position.y - CANVAS_BOX_HEADER) /
								(CANVAS_CARD_HEIGHT + CANVAS_CHAT_GAP),
						),
					)
				: 0,
		});
	}
	const orderedGroups = new Map<string, CanvasChat[]>();
	const arrivalsByBox = new Map<string, { chat: CanvasChat; index: number }[]>();
	for (const move of moves.values()) {
		if (!move.chat.boxId) continue;
		let arrivals = arrivalsByBox.get(move.chat.boxId);
		if (!arrivals) {
			arrivals = [];
			arrivalsByBox.set(move.chat.boxId, arrivals);
		}
		arrivals.push(move);
	}
	for (const [boxId, arrivals] of arrivalsByBox) {
		arrivals.sort((left, right) => left.index - right.index);
		const siblings = layout.chats(boxId).filter((chat) => !moves.has(chat.id));
		let previousIndex = -1;
		for (const { chat, index } of arrivals) {
			const insertAt = Math.min(siblings.length, Math.max(previousIndex + 1, index));
			siblings.splice(insertAt, 0, chat);
			previousIndex = insertAt;
		}
		orderedGroups.set(boxId, siblings);
	}
	return {
		...content,
		nodes: geometry.nodes.map((node) => {
			const moved = moves.get(node.id)?.chat ?? node;
			if (moved.type !== 'chat' || !moved.boxId) return moved;
			return orderedGroups.get(moved.boxId)?.shift() ?? moved;
		}),
	};
}

export function removeCanvasElements(
	content: CanvasContent,
	ids: ReadonlySet<string>,
): CanvasContent {
	const layout = new CanvasLayoutIndex(content);
	return {
		...content,
		nodes: content.nodes
			.filter((node) => !ids.has(node.id))
			.map((node) =>
				node.type === 'chat' && node.boxId && ids.has(node.boxId)
					? { ...node, boxId: null, position: layout.position(node) }
					: node,
			),
		connections: content.connections.filter(
			(edge) => !ids.has(edge.id) && !ids.has(edge.source) && !ids.has(edge.target),
		),
	};
}

export function availablePosition(
	content: CanvasContent,
	position: CanvasPosition,
): CanvasPosition {
	const layout = new CanvasLayoutIndex(content);
	const occupied = content.nodes.map((node) =>
		node.type === 'box'
			? layout.bounds(node)
			: {
					...layout.position(node),
					width: CANVAS_CARD_WIDTH,
					height: CANVAS_CARD_HEIGHT,
				},
	);
	let candidate = { ...position };
	for (;;) {
		const overlap = occupied.find(
			(bounds) =>
				candidate.x < bounds.x + bounds.width + 24 &&
				candidate.x + CANVAS_BOX_WIDTH + 24 > bounds.x &&
				candidate.y < bounds.y + bounds.height + 24 &&
				candidate.y + CANVAS_BOX_HEADER + CANVAS_CARD_HEIGHT + 24 > bounds.y,
		);
		if (!overlap) return candidate;
		candidate = { ...candidate, x: overlap.x + overlap.width + 24 };
	}
}
