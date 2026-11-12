import type { CanvasConnection, CanvasContent, CanvasNode } from '$shared/chat-canvas';

function sameNode(left: CanvasNode, right: CanvasNode): boolean {
	if (left === right) return true;
	if (
		left.id !== right.id ||
		left.position.x !== right.position.x ||
		left.position.y !== right.position.y
	) {
		return false;
	}
	if (left.type === 'box' && right.type === 'box') return left.title === right.title;
	return (
		left.type === 'chat' &&
		right.type === 'chat' &&
		left.chatId === right.chatId &&
		left.boxId === right.boxId
	);
}

function sameConnection(left: CanvasConnection, right: CanvasConnection): boolean {
	return (
		left === right ||
		(left.id === right.id &&
			left.source === right.source &&
			left.target === right.target &&
			left.sourceSide === right.sourceSide &&
			left.targetSide === right.targetSide &&
			left.label === right.label)
	);
}

export function canvasContentsEqual(left: CanvasContent, right: CanvasContent): boolean {
	return (
		left === right ||
		(left.title === right.title &&
			left.nodes.length === right.nodes.length &&
			left.connections.length === right.connections.length &&
			left.nodes.every((node, index) => sameNode(node, right.nodes[index])) &&
			left.connections.every((edge, index) => sameConnection(edge, right.connections[index])))
	);
}

// Keeps validation at the edit boundary while sharing unchanged elements across undo snapshots.
export function shareCanvasContent(previous: CanvasContent, next: CanvasContent): CanvasContent {
	if (canvasContentsEqual(previous, next)) return previous;
	const nodes = new Map(previous.nodes.map((node) => [node.id, node]));
	const connections = new Map(previous.connections.map((edge) => [edge.id, edge]));
	return {
		...next,
		nodes: next.nodes.map((node) => {
			const prior = nodes.get(node.id);
			return prior && sameNode(prior, node) ? prior : node;
		}),
		connections: next.connections.map((edge) => {
			const prior = connections.get(edge.id);
			return prior && sameConnection(prior, edge) ? prior : edge;
		}),
	};
}
