import { MarkerType, type Edge } from '@xyflow/svelte';
import type { CanvasContent } from '$shared/chat-canvas';
import {
	CanvasLayoutIndex,
	CANVAS_CARD_HEIGHT,
	CANVAS_CARD_WIDTH,
} from '$lib/chat-canvas/canvas-layout';
import type { CanvasFlowNode } from './canvas-node-types';

export function flowNodes(
	content: CanvasContent,
	selectedIds: ReadonlySet<string>,
): CanvasFlowNode[] {
	const layout = new CanvasLayoutIndex(content);
	const ordered = [
		...content.nodes.filter((node) => node.type === 'box'),
		...content.nodes.filter((node) => node.type === 'chat'),
	];
	return ordered.map((node) => {
		const absolute = layout.position(node);
		const parent =
			node.type === 'chat' && node.boxId
				? layout.byId.get(node.boxId)
				: null;
		return {
			id: node.id,
			type: node.type === 'box' ? 'canvasBox' : 'canvasChat',
			data: { kind: node.type },
			position: parent
				? { x: absolute.x - parent.position.x, y: absolute.y - parent.position.y }
				: absolute,
			parentId: parent?.id,
			width: node.type === 'box' ? layout.bounds(node).width : CANVAS_CARD_WIDTH,
			height: node.type === 'box' ? layout.bounds(node).height : CANVAS_CARD_HEIGHT,
			selected: selectedIds.has(node.id),
			dragHandle: '.canvas-drag-handle',
			ariaLabel: node.type === 'box' ? node.title : undefined,
			domAttributes:
				node.type === 'chat' ? { 'aria-labelledby': `canvas-chat-title-${node.id}` } : undefined,
		};
	});
}

export function flowEdges(content: CanvasContent, selectedIds: ReadonlySet<string>): Edge[] {
	return content.connections.map((edge) => ({
		id: edge.id,
		source: edge.source,
		target: edge.target,
		sourceHandle: edge.sourceSide,
		targetHandle: edge.targetSide,
		label: edge.label,
		selected: selectedIds.has(edge.id),
		type: 'smoothstep',
		markerEnd: { type: MarkerType.ArrowClosed },
		interactionWidth: 24,
		zIndex: 1,
	}));
}
