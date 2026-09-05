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
export const COMPACT_ENTER_WINDOW_WIDTH_PX = 240;
export const COMPACT_ENTER_WINDOW_HEIGHT_PX = 160;
export const COMPACT_EXIT_WINDOW_WIDTH_PX = 300;
export const COMPACT_EXIT_WINDOW_HEIGHT_PX = 200;
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

export interface WorkspaceSplitRequest {
	readonly targetWindowId: WorkspaceWindowId;
	readonly edge: WorkspaceWindowEdge;
	readonly movingSurfaceId?: string;
}

export interface WorkspaceSplitAdmissionInput extends WorkspaceSplitRequest {
	readonly snapshot: WorkspaceLayoutSnapshot;
	readonly hostSize: WorkspaceHostSize | null;
	readonly singleWindowProjectionActive: boolean;
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
	if (input.singleWindowProjectionActive) return { allowed: false, reason: 'too-small' };

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

	return childWidth >= SPLIT_MIN_WINDOW_WIDTH_PX && childHeight >= SPLIT_MIN_WINDOW_HEIGHT_PX
		? { allowed: true }
		: { allowed: false, reason: 'too-small' };
}

export function floorWorkspacePixels(fraction: number, hostPixels: number): number {
	return Math.floor(fraction * hostPixels);
}

export function resolveWorkspaceCompactActive(input: {
	readonly wasActive: boolean;
	readonly root: DesktopWorkspaceNode;
	readonly hostSize: WorkspaceHostSize | null;
}): boolean {
	if (!input.hostSize || collectWindowNodes(input.root).length < 2) return false;
	const rectangles = computeWindowRects(input.root).windows.map(({ rect }) => ({
		width: floorWorkspacePixels(rect.width, input.hostSize!.width),
		height: floorWorkspacePixels(rect.height, input.hostSize!.height),
	}));

	if (!input.wasActive) {
		return rectangles.some(
			(rect) =>
				rect.width < COMPACT_ENTER_WINDOW_WIDTH_PX || rect.height < COMPACT_ENTER_WINDOW_HEIGHT_PX,
		);
	}

	return !rectangles.every(
		(rect) =>
			rect.width >= COMPACT_EXIT_WINDOW_WIDTH_PX && rect.height >= COMPACT_EXIT_WINDOW_HEIGHT_PX,
	);
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
	if (!input.partitionAxisPixels || input.partitionAxisPixels <= 0) {
		return { min: MIN_PARTITION_RATIO, max: MAX_PARTITION_RATIO, adjustable: true };
	}
	const criticalPixels =
		input.partition.direction === 'horizontal'
			? COMPACT_ENTER_WINDOW_WIDTH_PX
			: COMPACT_ENTER_WINDOW_HEIGHT_PX;
	const requiredPixels = criticalPixels + WORKSPACE_RESIZE_BOUND_SAFETY_PX;
	const firstFraction = minimumLeafAxisFraction(
		input.partition.children[0],
		input.partition.direction,
	);
	const secondFraction = minimumLeafAxisFraction(
		input.partition.children[1],
		input.partition.direction,
	);
	const min = Math.max(
		MIN_PARTITION_RATIO,
		requiredPixels / (input.partitionAxisPixels * firstFraction),
	);
	const max = Math.min(
		MAX_PARTITION_RATIO,
		1 - requiredPixels / (input.partitionAxisPixels * secondFraction),
	);
	if (min > max) {
		const retained = Math.min(
			MAX_PARTITION_RATIO,
			Math.max(MIN_PARTITION_RATIO, input.partition.ratio),
		);
		return { min: retained, max: retained, adjustable: false };
	}
	return { min, max, adjustable: true };
}

export function clampWorkspacePartitionRatio(
	ratio: number,
	bounds: WorkspacePartitionRatioBounds,
): number {
	if (!Number.isFinite(ratio)) return Math.min(bounds.max, Math.max(bounds.min, 0.5));
	return Math.min(bounds.max, Math.max(bounds.min, ratio));
}
