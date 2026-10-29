import {
	MAX_PARTITION_RATIO,
	MIN_PARTITION_RATIO,
	partitionDirectionForEdge,
	windowEdgePosition,
	type DesktopWorkspaceNode,
	type WorkspacePartitionId,
	type WorkspacePartitionNode,
	type WorkspaceWindowEdge,
	type WorkspaceWindowId,
	type WorkspaceWindowNode,
} from './surface-types.js';

export function clampPartitionRatio(ratio: number): number {
	if (!Number.isFinite(ratio)) return 0.5;
	return Math.min(MAX_PARTITION_RATIO, Math.max(MIN_PARTITION_RATIO, ratio));
}

export function collectWindowNodes(root: DesktopWorkspaceNode): WorkspaceWindowNode[] {
	if (root.type === 'window') return [root];
	return [...collectWindowNodes(root.children[0]), ...collectWindowNodes(root.children[1])];
}

export function windowCount(root: DesktopWorkspaceNode): number {
	return collectWindowNodes(root).length;
}

export function projectedWindowCountAfterTabMove(
	root: DesktopWorkspaceNode,
	sourceWindowId: WorkspaceWindowId,
	targetWindowId: WorkspaceWindowId,
): number {
	const count = windowCount(root);
	const source = windowNodeById(root, sourceWindowId);
	if (!source) return count + 1;
	if (sourceWindowId === targetWindowId && source.tabs.order.length === 1) return count;
	const collapsesSource = sourceWindowId !== targetWindowId && source.tabs.order.length === 1;
	return count - (collapsesSource ? 1 : 0) + 1;
}

export function windowNodeById(
	root: DesktopWorkspaceNode,
	windowId: WorkspaceWindowId,
): WorkspaceWindowNode | null {
	if (root.type === 'window') return root.id === windowId ? root : null;
	return windowNodeById(root.children[0], windowId) ?? windowNodeById(root.children[1], windowId);
}

export function windowIdOfSurface(
	root: DesktopWorkspaceNode,
	surfaceId: string,
): WorkspaceWindowId | null {
	for (const workspaceWindow of collectWindowNodes(root)) {
		if (workspaceWindow.tabs.order.includes(surfaceId)) return workspaceWindow.id;
	}
	return null;
}

export function mapWindows(
	node: DesktopWorkspaceNode,
	map: (workspaceWindow: WorkspaceWindowNode) => WorkspaceWindowNode,
): DesktopWorkspaceNode {
	if (node.type === 'window') return map(node);
	return {
		...node,
		children: [mapWindows(node.children[0], map), mapWindows(node.children[1], map)],
	};
}

export function replaceWindowNode(
	node: DesktopWorkspaceNode,
	windowId: WorkspaceWindowId,
	replacement: DesktopWorkspaceNode,
): DesktopWorkspaceNode {
	if (node.type === 'window') return node.id === windowId ? replacement : node;
	const first = replaceWindowNode(node.children[0], windowId, replacement);
	if (first !== node.children[0]) return { ...node, children: [first, node.children[1]] };
	const second = replaceWindowNode(node.children[1], windowId, replacement);
	if (second !== node.children[1]) return { ...node, children: [node.children[0], second] };
	return node;
}

export function mapPartitions(
	node: DesktopWorkspaceNode,
	map: (partition: WorkspacePartitionNode) => WorkspacePartitionNode,
): DesktopWorkspaceNode {
	if (node.type === 'window') return node;
	return map({
		...node,
		children: [mapPartitions(node.children[0], map), mapPartitions(node.children[1], map)],
	});
}

export function removeWindowAndCollapse(
	root: DesktopWorkspaceNode,
	windowId: WorkspaceWindowId,
): DesktopWorkspaceNode | null {
	if (root.type === 'window') return null;
	const [first, second] = root.children;
	if (first.type === 'window' && first.id === windowId) return second;
	if (second.type === 'window' && second.id === windowId) return first;
	const nextFirst = removeWindowAndCollapse(first, windowId);
	if (nextFirst) return { ...root, children: [nextFirst, second] };
	const nextSecond = removeWindowAndCollapse(second, windowId);
	if (nextSecond) return { ...root, children: [first, nextSecond] };
	return null;
}

export function insertWindowAtEdge(
	root: DesktopWorkspaceNode,
	targetWindowId: WorkspaceWindowId,
	edge: WorkspaceWindowEdge,
	newWindow: WorkspaceWindowNode,
	partitionId: WorkspacePartitionId,
): DesktopWorkspaceNode {
	const target = windowNodeById(root, targetWindowId);
	if (!target) return root;
	const children: [DesktopWorkspaceNode, DesktopWorkspaceNode] =
		windowEdgePosition(edge) === 'before' ? [newWindow, target] : [target, newWindow];
	const partition: WorkspacePartitionNode = {
		type: 'partition',
		id: partitionId,
		direction: partitionDirectionForEdge(edge),
		ratio: 0.5,
		children,
	};
	return replaceWindowNode(root, targetWindowId, partition);
}

/**
 * Gives every column in a window's row an equal width. The row is the outermost run of
 * horizontal partitions enclosing the window; the windows and vertical partitions inside it are
 * its columns. Returns null when the window has no row or an equal share needs a ratio outside
 * the partition bounds.
 */
export function balanceWindowRow(
	root: DesktopWorkspaceNode,
	windowId: WorkspaceWindowId,
): DesktopWorkspaceNode | null {
	const rowRoot = outermostRowAncestor(root, windowId, null);
	if (!rowRoot) return null;
	const balanced = equalizeColumns(rowRoot);
	if (!balanced) return null;
	return mapPartitions(root, (partition) =>
		partition.id === rowRoot.id ? (balanced as WorkspacePartitionNode) : partition,
	);
}

function outermostRowAncestor(
	node: DesktopWorkspaceNode,
	windowId: WorkspaceWindowId,
	enclosingRow: WorkspacePartitionNode | null,
): WorkspacePartitionNode | null {
	if (node.type === 'window') return node.id === windowId ? enclosingRow : null;
	const row = node.direction === 'horizontal' ? (enclosingRow ?? node) : null;
	return (
		outermostRowAncestor(node.children[0], windowId, row) ??
		outermostRowAncestor(node.children[1], windowId, row)
	);
}

function rowColumnCount(node: DesktopWorkspaceNode): number {
	if (node.type === 'window' || node.direction !== 'horizontal') return 1;
	return rowColumnCount(node.children[0]) + rowColumnCount(node.children[1]);
}

function equalizeColumns(node: DesktopWorkspaceNode): DesktopWorkspaceNode | null {
	if (node.type === 'window' || node.direction !== 'horizontal') return node;
	const ratio = rowColumnCount(node.children[0]) / rowColumnCount(node);
	if (clampPartitionRatio(ratio) !== ratio) return null;
	const first = equalizeColumns(node.children[0]);
	const second = equalizeColumns(node.children[1]);
	if (!first || !second) return null;
	return { ...node, ratio, children: [first, second] };
}

export interface WorkspaceWindowRect {
	readonly left: number;
	readonly top: number;
	readonly width: number;
	readonly height: number;
}

export interface WorkspaceWindowRectEntry {
	readonly workspaceWindow: WorkspaceWindowNode;
	readonly rect: WorkspaceWindowRect;
}

export interface WorkspacePartitionRectEntry {
	readonly partition: WorkspacePartitionNode;
	readonly bounds: WorkspaceWindowRect;
}

export interface WorkspaceWindowTreeGeometry {
	readonly windows: readonly WorkspaceWindowRectEntry[];
	readonly partitions: readonly WorkspacePartitionRectEntry[];
}

export function computeWindowRects(
	root: DesktopWorkspaceNode,
	ratioOverride?: (partitionId: WorkspacePartitionId, ratio: number) => number,
): WorkspaceWindowTreeGeometry {
	const windows: WorkspaceWindowRectEntry[] = [];
	const partitions: WorkspacePartitionRectEntry[] = [];
	const walk = (node: DesktopWorkspaceNode, rect: WorkspaceWindowRect): void => {
		if (node.type === 'window') {
			windows.push({ workspaceWindow: node, rect });
			return;
		}
		const ratio = ratioOverride?.(node.id, node.ratio) ?? node.ratio;
		partitions.push({ partition: node, bounds: rect });
		const firstFraction = clampPartitionRatio(ratio);
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
			return;
		}
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
	};
	walk(root, { left: 0, top: 0, width: 1, height: 1 });
	return { windows, partitions };
}
