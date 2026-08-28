// Pure helpers over the immutable desktop pane tree. Reducers and selectors
// share these so traversal rules live in exactly one place.

import {
	MAX_SPLIT_RATIO,
	MIN_SPLIT_RATIO,
	splitEdgeDirection,
	splitEdgePosition,
	type DesktopLayoutNode,
	type PaneId,
	type PaneNode,
	type PaneTabState,
	type SplitEdge,
	type SplitId,
	type WorkspaceSplitNode,
} from './surface-types.js';

export function clampSplitRatio(ratio: number): number {
	if (!Number.isFinite(ratio)) return 0.5;
	return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
}

export function collectPaneNodes(root: DesktopLayoutNode): PaneNode[] {
	if (root.type === 'pane') return [root];
	return [...collectPaneNodes(root.children[0]), ...collectPaneNodes(root.children[1])];
}

export function paneCount(root: DesktopLayoutNode): number {
	return collectPaneNodes(root).length;
}

export function projectedPaneCountAfterTabSplit(
	root: DesktopLayoutNode,
	sourcePaneId: PaneId,
	targetPaneId: PaneId,
): number {
	const count = paneCount(root);
	const source = paneNodeById(root, sourcePaneId);
	if (!source) return count + 1;
	if (sourcePaneId === targetPaneId && source.tabs.order.length === 1) return count;
	const collapsesSource = sourcePaneId !== targetPaneId && source.tabs.order.length === 1;
	return count - (collapsesSource ? 1 : 0) + 1;
}

export function paneNodeById(root: DesktopLayoutNode, paneId: PaneId): PaneNode | null {
	if (root.type === 'pane') return root.id === paneId ? root : null;
	return paneNodeById(root.children[0], paneId) ?? paneNodeById(root.children[1], paneId);
}

export function paneIdOfSurface(root: DesktopLayoutNode, surfaceId: string): PaneId | null {
	for (const pane of collectPaneNodes(root)) {
		if (pane.tabs.order.includes(surfaceId)) return pane.id;
	}
	return null;
}

export function tabsOfPane(root: DesktopLayoutNode, paneId: PaneId): PaneTabState | null {
	return paneNodeById(root, paneId)?.tabs ?? null;
}

// Maps every pane in the tree, preserving split structure.
export function mapPanes(
	node: DesktopLayoutNode,
	map: (pane: PaneNode) => PaneNode,
): DesktopLayoutNode {
	if (node.type === 'pane') return map(node);
	return {
		...node,
		children: [mapPanes(node.children[0], map), mapPanes(node.children[1], map)],
	};
}

// Replaces the pane with the given ID. Returns the original root when the
// pane does not exist so callers can detect a no-op by identity.
export function replacePaneNode(
	node: DesktopLayoutNode,
	paneId: PaneId,
	replacement: DesktopLayoutNode,
): DesktopLayoutNode {
	if (node.type === 'pane') {
		return node.id === paneId ? replacement : node;
	}
	const first = replacePaneNode(node.children[0], paneId, replacement);
	if (first !== node.children[0]) return { ...node, children: [first, node.children[1]] };
	const second = replacePaneNode(node.children[1], paneId, replacement);
	if (second !== node.children[1]) return { ...node, children: [node.children[0], second] };
	return node;
}

// Maps every split node in the tree, bottom-up.
export function mapSplits(
	node: DesktopLayoutNode,
	map: (split: WorkspaceSplitNode) => WorkspaceSplitNode,
): DesktopLayoutNode {
	if (node.type === 'pane') return node;
	return map({
		...node,
		children: [mapSplits(node.children[0], map), mapSplits(node.children[1], map)],
	});
}

// Removes a pane and collapses its parent split into the sibling subtree.
// Returns null when the pane is missing or is the root pane.
export function removePaneAndCollapse(
	root: DesktopLayoutNode,
	paneId: PaneId,
): DesktopLayoutNode | null {
	if (root.type === 'pane') return null;
	const [first, second] = root.children;
	if (first.type === 'pane' && first.id === paneId) return second;
	if (second.type === 'pane' && second.id === paneId) return first;
	const nextFirst = removePaneAndCollapse(first, paneId);
	if (nextFirst) return { ...root, children: [nextFirst, second] };
	const nextSecond = removePaneAndCollapse(second, paneId);
	if (nextSecond) return { ...root, children: [first, nextSecond] };
	return null;
}

// Wraps the target pane in a new split so the new pane sits on the given edge.
// Returns the original root when the target pane does not exist.
export function insertPaneSplit(
	root: DesktopLayoutNode,
	targetPaneId: PaneId,
	edge: SplitEdge,
	newPane: PaneNode,
	splitId: SplitId,
): DesktopLayoutNode {
	const target = paneNodeById(root, targetPaneId);
	if (!target) return root;
	const children: [DesktopLayoutNode, DesktopLayoutNode] =
		splitEdgePosition(edge) === 'before' ? [newPane, target] : [target, newPane];
	const split: WorkspaceSplitNode = {
		type: 'split',
		id: splitId,
		direction: splitEdgeDirection(edge),
		ratio: 0.5,
		children,
	};
	return replacePaneNode(root, targetPaneId, split);
}

// Fractional (0-1) layout of the pane tree. Rendering consumes these rects to
// position panes and splitters absolutely, which keeps pane component
// instances stable across tree restructures like pane collapse.
export interface PaneRect {
	readonly left: number;
	readonly top: number;
	readonly width: number;
	readonly height: number;
}

export interface PaneRectEntry {
	readonly pane: PaneNode;
	readonly rect: PaneRect;
}

export interface SplitRectEntry {
	readonly split: WorkspaceSplitNode;
	readonly bounds: PaneRect;
}

export interface PaneTreeGeometry {
	readonly panes: readonly PaneRectEntry[];
	readonly splits: readonly SplitRectEntry[];
}

export function computePaneRects(
	root: DesktopLayoutNode,
	ratioOverride?: (splitId: SplitId, ratio: number) => number,
): PaneTreeGeometry {
	const panes: PaneRectEntry[] = [];
	const splits: SplitRectEntry[] = [];
	const walk = (node: DesktopLayoutNode, rect: PaneRect): void => {
		if (node.type === 'pane') {
			panes.push({ pane: node, rect });
			return;
		}
		const ratio = ratioOverride?.(node.id, node.ratio) ?? node.ratio;
		splits.push({ split: node, bounds: rect });
		const firstFraction = clampSplitRatio(ratio);
		if (node.direction === 'horizontal') {
			walk(node.children[0], {
				left: rect.left,
				top: rect.top,
				width: rect.width * firstFraction,
				height: rect.height,
			});
			walk(node.children[1], {
				left: rect.left + rect.width * firstFraction,
				top: rect.top,
				width: rect.width * (1 - firstFraction),
				height: rect.height,
			});
		} else {
			walk(node.children[0], {
				left: rect.left,
				top: rect.top,
				width: rect.width,
				height: rect.height * firstFraction,
			});
			walk(node.children[1], {
				left: rect.left,
				top: rect.top + rect.height * firstFraction,
				width: rect.width,
				height: rect.height * (1 - firstFraction),
			});
		}
	};
	walk(root, { left: 0, top: 0, width: 1, height: 1 });
	return { panes, splits };
}
