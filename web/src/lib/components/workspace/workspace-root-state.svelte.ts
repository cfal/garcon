import type { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte.js';
import type { WorkspaceCoordinator } from '$lib/workspace/workspace-coordinator.svelte.js';
import { SurfaceFrameBridge } from '$lib/workspace/surface-frame-context.js';
import {
	DEFAULT_WORKSPACE_SIDEBAR_WIDTH,
	clampDesiredSidebarWidth,
	getPushSidebarMaximum,
	resolveWorkspaceSidebarMetrics,
	WORKSPACE_SIDEBAR_HANDLE_WIDTH,
	type SidebarMetrics,
} from '$lib/workspace/sidebar-sizing.js';
import {
	MIN_WORKSPACE_SIDEBAR_WIDTH,
	type HostId,
	type WorkspaceLayoutSnapshot,
} from '$lib/workspace/surface-types.js';
import {
	resolveMainInlineInsets,
	type DesktopLayoutOrder,
	type MainInlineInsets,
} from '$lib/layout/desktop-layout.js';
import {
	nextRetainedSingletonPresentationKeys,
	type PortablePresentation,
} from '$lib/workspace/visible-presentations.js';

interface WorkspaceRootStateOptions {
	workspace: WorkspaceCoordinator;
	transientLayers: TransientLayerRegistry;
	get snapshot(): WorkspaceLayoutSnapshot;
	get isMobile(): boolean;
	get sidebarPresented(): boolean;
	get portablePresentations(): readonly PortablePresentation[];
	get desktopLayoutOrder(): DesktopLayoutOrder;
	get chatListWidth(): number;
}

export class WorkspaceRootState {
	workspaceWidth = $state<number | null>(null);
	resizePreviewWidth = $state<number | null>(null);
	retainedSingletonPresentationKeys = $state.raw<ReadonlySet<string>>(new Set());
	readonly #frameBridges = new Map<string, SurfaceFrameBridge>();
	#resizeObserver: ResizeObserver | null = null;
	#hostRegionWidth: number | null = null;

	constructor(private readonly options: WorkspaceRootStateOptions) {}

	get sidebarMetrics(): SidebarMetrics {
		if (this.workspaceWidth === null) {
			return {
				mode: 'push',
				width: clampDesiredSidebarWidth(this.options.snapshot.desiredSidebarWidth),
			};
		}
		return resolveWorkspaceSidebarMetrics(
			this.workspaceWidth,
			WORKSPACE_SIDEBAR_HANDLE_WIDTH,
			this.resizePreviewWidth ?? this.options.snapshot.desiredSidebarWidth,
		);
	}

	get sidebarPushMaximum(): number {
		if (this.workspaceWidth === null) {
			return Math.max(MIN_WORKSPACE_SIDEBAR_WIDTH, this.sidebarMetrics.width);
		}
		return Math.max(
			MIN_WORKSPACE_SIDEBAR_WIDTH,
			Math.floor(getPushSidebarMaximum(this.workspaceWidth, WORKSPACE_SIDEBAR_HANDLE_WIDTH)),
		);
	}

	get mainInsets(): MainInlineInsets {
		return resolveMainInlineInsets(this.options.desktopLayoutOrder, {
			chatList: this.options.chatListWidth,
			workspaceSidebar:
				this.options.sidebarPresented && this.sidebarMetrics.mode === 'push'
					? this.sidebarMetrics.width
					: 0,
		});
	}

	get overlayMainInsets(): MainInlineInsets {
		return resolveMainInlineInsets(this.options.desktopLayoutOrder, {
			chatList: this.options.chatListWidth,
			workspaceSidebar: 0,
		});
	}

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

	readonly observeHostRegion = (element: HTMLDivElement): { destroy: () => void } => {
		this.#resizeObserver?.disconnect();
		const observer = new ResizeObserver(([entry]) => {
			this.#hostRegionWidth = entry?.contentRect.width ?? element.clientWidth;
			this.#syncWorkspaceWidth();
		});
		this.#resizeObserver = observer;
		observer.observe(element);
		this.#hostRegionWidth = element.clientWidth;
		this.#syncWorkspaceWidth();
		return {
			destroy: () => {
				observer.disconnect();
				if (this.#resizeObserver === observer) this.#resizeObserver = null;
				this.#hostRegionWidth = null;
			},
		};
	};

	syncChatListWidth(): void {
		this.#syncWorkspaceWidth();
	}

	async commitSidebarWidth(width: number): Promise<void> {
		this.resizePreviewWidth = width;
		try {
			await this.options.workspace.setSidebarWidth(width);
		} finally {
			if (this.resizePreviewWidth === width) this.resizePreviewWidth = null;
		}
	}

	resetSidebarWidth(): void {
		void this.commitSidebarWidth(DEFAULT_WORKSPACE_SIDEBAR_WIDTH);
	}

	surfaceStyle(presentation: HostId | 'mobile'): string {
		if (presentation === 'mobile') return 'inset: 0;';
		if (presentation === 'sidebar') {
			return 'inset-block-start: var(--workspace-floating-taskbar-inset); inset-block-end: 0; inset-inline: 0;';
		}
		const insets = this.mainInsets;
		return `inset-block-start: var(--workspace-floating-taskbar-inset); inset-block-end: 0; inset-inline-start: ${insets.start}px; inset-inline-end: ${insets.end}px;`;
	}

	#syncWorkspaceWidth(): void {
		if (this.#hostRegionWidth === null) return;
		const nextWidth = Math.max(0, this.#hostRegionWidth - this.options.chatListWidth);
		const nextMetrics = resolveWorkspaceSidebarMetrics(
			nextWidth,
			WORKSPACE_SIDEBAR_HANDLE_WIDTH,
			this.options.snapshot.desiredSidebarWidth,
		);
		if (
			this.workspaceWidth !== null &&
			this.options.sidebarPresented &&
			this.sidebarMetrics.mode === 'push' &&
			nextMetrics.mode === 'overlay'
		) {
			this.options.transientLayers.open('main-inert', () => {
				this.workspaceWidth = nextWidth;
			});
			return;
		}
		this.workspaceWidth = nextWidth;
	}

	destroy(): void {
		this.#resizeObserver?.disconnect();
		this.#resizeObserver = null;
		this.#hostRegionWidth = null;
		for (const bridge of this.#frameBridges.values()) bridge.deactivate();
		this.#frameBridges.clear();
	}
}
