import {
	MAX_PARTITION_RATIO,
	MIN_PARTITION_RATIO,
	WORKSPACE_WINDOW_RESOURCE_CEILING,
	type DesktopWorkspaceNode,
	type WorkspaceLayoutSnapshot,
	type WorkspacePartitionDirection,
	type WorkspacePartitionId,
	type WorkspacePartitionNode,
	type WorkspaceWindowEdge,
	type WorkspaceWindowId,
} from './surface-types.js';
import {
	collectWindowNodes,
	computeWindowRects,
	removeWindowAndCollapse,
	windowIdOfSurface,
	windowNodeById,
} from './window-tree.js';

export const SPLIT_MIN_WINDOW_WIDTH_PX = 360;
export const SPLIT_MIN_WINDOW_HEIGHT_PX = 240;
export const MIN_WINDOW_WIDTH_PX = 240;
export const MIN_WINDOW_HEIGHT_PX = 160;
export const WORKSPACE_RESIZE_BOUND_SAFETY_PX = 1;

export interface WorkspaceHostSize {
	readonly width: number;
	readonly height: number;
}

export type WorkspaceSplitBlockReason = 'too-small' | 'resource-ceiling' | 'fullscreen';

export type WorkspaceSplitAdmission =
	| { readonly allowed: true }
	| { readonly allowed: false; readonly reason: WorkspaceSplitBlockReason };

export type WorkspaceSplitAdmissions = Readonly<
	Record<WorkspaceWindowEdge, WorkspaceSplitAdmission | null>
>;

export function mapWorkspaceSplitAdmissions(
	admissionForEdge: (edge: WorkspaceWindowEdge) => WorkspaceSplitAdmission | null,
): WorkspaceSplitAdmissions {
	return {
		left: admissionForEdge('left'),
		right: admissionForEdge('right'),
		top: admissionForEdge('top'),
		bottom: admissionForEdge('bottom'),
	};
}

export interface WorkspaceSplitRequest {
	readonly targetWindowId: WorkspaceWindowId;
	readonly edge: WorkspaceWindowEdge;
	readonly movingSurfaceId?: string;
}

export interface WorkspaceSplitAdmissionInput extends WorkspaceSplitRequest {
	readonly snapshot: WorkspaceLayoutSnapshot;
	readonly hostSize: WorkspaceHostSize | null;
}

export type WorkspaceSplitAdmissionResolver = (
	snapshot: WorkspaceLayoutSnapshot,
	request: WorkspaceSplitRequest,
) => WorkspaceSplitAdmission | null;

export interface WorkspacePartitionRatioBounds {
	readonly min: number;
	readonly max: number;
	readonly adjustable: boolean;
}

export interface ResolvedWorkspacePartitionRatioBounds {
	readonly currentRatio: number;
	readonly bounds: WorkspacePartitionRatioBounds;
}

export type WorkspacePartitionRatioBoundsResolver = (
	snapshot: WorkspaceLayoutSnapshot,
	partitionId: WorkspacePartitionId,
) => ResolvedWorkspacePartitionRatioBounds | null;

function rootAfterProjectedSourceCollapse(
	root: DesktopWorkspaceNode,
	targetWindowId: WorkspaceWindowId,
	movingSurfaceId: string | undefined,
): DesktopWorkspaceNode | null {
	if (!movingSurfaceId) return root;
	const sourceWindowId = windowIdOfSurface(root, movingSurfaceId);
	if (!sourceWindowId) return null;
	const sourceWindow = windowNodeById(root, sourceWindowId);
	if (!sourceWindow) return null;
	if (sourceWindowId === targetWindowId && sourceWindow.tabs.order.length === 1) return null;
	if (sourceWindowId === targetWindowId || sourceWindow.tabs.order.length > 1) return root;
	return removeWindowAndCollapse(root, sourceWindowId);
}

export function resolveWorkspaceSplitAdmission(
	input: WorkspaceSplitAdmissionInput,
): WorkspaceSplitAdmission | null {
	if (input.snapshot.fullscreenWindowId) return { allowed: false, reason: 'fullscreen' };

	const root = rootAfterProjectedSourceCollapse(
		input.snapshot.desktopRoot,
		input.targetWindowId,
		input.movingSurfaceId,
	);
	if (!root || !windowNodeById(root, input.targetWindowId)) return null;

	if (collectWindowNodes(root).length + 1 > WORKSPACE_WINDOW_RESOURCE_CEILING) {
		return { allowed: false, reason: 'resource-ceiling' };
	}
	if (!input.hostSize) return { allowed: true };

	const entry = computeWindowRects(root).windows.find(
		(candidate) => candidate.workspaceWindow.id === input.targetWindowId,
	);
	if (!entry) return null;

	const width = floorWorkspacePixels(entry.rect.width, input.hostSize.width);
	const height = floorWorkspacePixels(entry.rect.height, input.hostSize.height);
	const horizontal = input.edge === 'left' || input.edge === 'right';
	const childWidth = horizontal ? Math.floor(width / 2) : width;
	const childHeight = horizontal ? height : Math.floor(height / 2);

	if (childWidth < SPLIT_MIN_WINDOW_WIDTH_PX || childHeight < SPLIT_MIN_WINDOW_HEIGHT_PX) {
		return { allowed: false, reason: 'too-small' };
	}
	return { allowed: true };
}

export function floorWorkspacePixels(fraction: number, hostPixels: number): number {
	return Math.floor(fraction * hostPixels);
}

function siblingWindowId(
	root: DesktopWorkspaceNode,
	windowId: WorkspaceWindowId,
): WorkspaceWindowId | null {
	if (root.type === 'window') return null;
	const [first, second] = root.children;
	if (first.type === 'window' && first.id === windowId) return collectWindowNodes(second)[0].id;
	if (second.type === 'window' && second.id === windowId) return collectWindowNodes(first)[0].id;
	return siblingWindowId(first, windowId) ?? siblingWindowId(second, windowId);
}

export function workspaceWindowsToPrune(
	root: DesktopWorkspaceNode,
	hostSize: WorkspaceHostSize | null,
	currentWindowId: WorkspaceWindowId,
): WorkspaceWindowId[] {
	if (!hostSize || !windowNodeById(root, currentWindowId)) return [];
	const removed: WorkspaceWindowId[] = [];
	let remaining = root;
	while (true) {
		const windows = computeWindowRects(remaining).windows;
		if (windows.length < 2) break;
		const undersized = windows.filter(
			({ rect }) =>
				floorWorkspacePixels(rect.width, hostSize.width) < MIN_WINDOW_WIDTH_PX ||
				floorWorkspacePixels(rect.height, hostSize.height) < MIN_WINDOW_HEIGHT_PX,
		);
		if (undersized.length === 0) break;
		const sourceWindowId =
			undersized.find(({ workspaceWindow }) => workspaceWindow.id !== currentWindowId)
				?.workspaceWindow.id ?? siblingWindowId(remaining, currentWindowId);
		if (!sourceWindowId) break;
		const collapsed = removeWindowAndCollapse(remaining, sourceWindowId);
		if (!collapsed) break;
		removed.push(sourceWindowId);
		remaining = collapsed;
	}
	return removed;
}

function minimumLeafAxisFraction(
	node: DesktopWorkspaceNode,
	direction: WorkspacePartitionDirection,
): number {
	if (node.type === 'window') return 1;
	const first = minimumLeafAxisFraction(node.children[0], direction);
	const second = minimumLeafAxisFraction(node.children[1], direction);
	if (node.direction !== direction) return Math.min(first, second);
	return Math.min(node.ratio * first, (1 - node.ratio) * second);
}

export function resolveWorkspacePartitionRatioBounds(input: {
	readonly partition: WorkspacePartitionNode;
	readonly partitionAxisPixels: number | null;
}): WorkspacePartitionRatioBounds {
	const { partition, partitionAxisPixels } = input;
	if (!partitionAxisPixels || partitionAxisPixels <= 0) {
		return { min: MIN_PARTITION_RATIO, max: MAX_PARTITION_RATIO, adjustable: true };
	}
	const criticalPixels =
		partition.direction === 'horizontal' ? MIN_WINDOW_WIDTH_PX : MIN_WINDOW_HEIGHT_PX;
	const requiredPixels = criticalPixels + WORKSPACE_RESIZE_BOUND_SAFETY_PX;
	const firstFraction = minimumLeafAxisFraction(partition.children[0], partition.direction);
	const secondFraction = minimumLeafAxisFraction(partition.children[1], partition.direction);
	const min = Math.max(MIN_PARTITION_RATIO, requiredPixels / (partitionAxisPixels * firstFraction));
	const max = Math.min(
		MAX_PARTITION_RATIO,
		1 - requiredPixels / (partitionAxisPixels * secondFraction),
	);
	if (min > max) {
		const retained = Math.min(MAX_PARTITION_RATIO, Math.max(MIN_PARTITION_RATIO, partition.ratio));
		return { min: retained, max: retained, adjustable: false };
	}
	return { min, max, adjustable: true };
}

export function clampWorkspacePartitionRatio(
	ratio: number,
	bounds: WorkspacePartitionRatioBounds,
): number {
	const candidate = Number.isFinite(ratio) ? ratio : 0.5;
	return Math.min(bounds.max, Math.max(bounds.min, candidate));
}
