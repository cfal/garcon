import { SurfaceFrameBridge } from '$lib/workspace/surface-frame-context.js';
import type { WorkspacePartitionId } from '$lib/workspace/surface-types.js';
import type { WorkspaceLayoutSnapshot } from '$lib/workspace/surface-types.js';
import {
	nextRetainedSingletonPresentationKeys,
	type PortablePresentation,
} from '$lib/workspace/visible-presentations.js';

interface WorkspaceRootStateOptions {
	get snapshot(): WorkspaceLayoutSnapshot;
	get isMobile(): boolean;
	get portablePresentations(): readonly PortablePresentation[];
}

export class WorkspaceRootState {
	retainedSingletonPresentationKeys = $state.raw<ReadonlySet<string>>(new Set());
	partitionRatioPreviews = $state<Readonly<Record<string, number>>>({});
	readonly #frameBridges = new Map<string, SurfaceFrameBridge>();

	constructor(private readonly options: WorkspaceRootStateOptions) {}

	frameBridge(surfaceId: string): SurfaceFrameBridge {
		let bridge = this.#frameBridges.get(surfaceId);
		if (!bridge) {
			bridge = new SurfaceFrameBridge();
			this.#frameBridges.set(surfaceId, bridge);
		}
		return bridge;
	}

	syncPresentationState(): void {
		const snapshot = this.options.snapshot;
		const liveSurfaceIds = new Set(Object.keys(snapshot.surfaces));
		for (const [surfaceId, bridge] of this.#frameBridges) {
			if (liveSurfaceIds.has(surfaceId)) continue;
			bridge.deactivate();
			this.#frameBridges.delete(surfaceId);
		}
		const current = this.retainedSingletonPresentationKeys;
		const next = nextRetainedSingletonPresentationKeys(
			snapshot,
			this.options.isMobile,
			this.options.portablePresentations,
			current,
		);
		if (next.size === current.size && [...next].every((key) => current.has(key))) return;
		this.retainedSingletonPresentationKeys = next;
	}

	setPartitionRatioPreview(partitionId: WorkspacePartitionId, ratio: number | null): void {
		if (ratio === null) {
			if (!(partitionId in this.partitionRatioPreviews)) return;
			const { [partitionId]: _removed, ...remaining } = this.partitionRatioPreviews;
			this.partitionRatioPreviews = remaining;
			return;
		}
		this.partitionRatioPreviews = { ...this.partitionRatioPreviews, [partitionId]: ratio };
	}

	partitionRatio(partitionId: WorkspacePartitionId, fallback: number): number {
		return this.partitionRatioPreviews[partitionId] ?? fallback;
	}

	surfaceStyle(presentation: string): string {
		if (presentation === 'mobile') return 'inset: 0;';
		return 'inset: 0;';
	}

	destroy(): void {
		for (const bridge of this.#frameBridges.values()) bridge.deactivate();
		this.#frameBridges.clear();
	}
}
