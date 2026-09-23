import {
	PORTABLE_SINGLETON_KINDS,
	type PortableSingletonKind,
} from '$lib/workspace/surface-types.js';
import type { PortableSingletonController } from '$lib/workspace/portable-singleton-controller.js';
import { FileTreeStore } from '$lib/files/tree/file-tree.svelte.js';
import type { GitSurfaceControllerDeps } from '$lib/git/surface/git-surface-controller-deps.js';
import { GitWorkbenchSurfaceController } from '$lib/git/workbench/git-workbench-surface.svelte.js';
import { GitHistorySurfaceController } from '$lib/git/history/git-history-surface.svelte.js';
import { GitCompareSurfaceController } from '$lib/git/review/git-compare-surface.svelte.js';
import type { GitComparisonPreferences } from '$lib/git/review/git-comparison-preferences.js';
import { PullRequestsStore } from '$lib/git/pull-requests/pull-requests-store.svelte.js';
import { CommitController } from '$lib/git/commit/commit-controller.svelte.js';
import { ChatMapController } from '$lib/chat-map/chat-map-controller.svelte.js';
import { CanvasController } from '$lib/chat-canvas/canvas-controller.svelte.js';
import { CanvasExitGuard } from '$lib/chat-canvas/canvas-exit-guard.js';
import { browserCanvasRecovery } from '$lib/chat-canvas/canvas-recovery.js';
import type { ChatBoardController } from '$lib/chat-board/catalog/chat-board-controller.svelte.js';
import type { TicketsController } from '$lib/tickets/catalog/tickets-controller.svelte.js';
import type { WorkspaceProjectState } from '$lib/workspace/workspace-context.svelte.js';
import { untrack } from 'svelte';
import { effectiveNodeId } from '$shared/execution-nodes';
import { filePathRelativeToTreeRoot } from '$lib/files/tree/file-tree-path.js';
import type { ExecutionNodesStore } from '$lib/execution-nodes/execution-nodes-store.svelte.js';

export interface SingletonSurfaceRegistryDeps extends GitSurfaceControllerDeps {
	createCommit(): CommitController;
	createPullRequests(): PullRequestsStore;
	comparisonPreferences: GitComparisonPreferences;
	createChatBoard?(): ChatBoardController;
	createTickets?(): TicketsController;
	executionNodes?: Pick<ExecutionNodesStore, 'filesAvailable' | 'pathContextKey'>;
}

export class FilesSurfaceController implements PortableSingletonController {
	readonly tree = new FileTreeStore();
	presentationVisible = $state(false);
	#projectState = $state.raw<WorkspaceProjectState>({ kind: 'absent' });
	#selectedNodeId = $state<string | null>(null);
	#projectPath: string | null = null;
	#pendingReveal = $state.raw<{
		nodeId: string;
		fileRootPath: string;
		relativePath: string;
	} | null>(null);

	constructor(
		private readonly nodes?: Pick<ExecutionNodesStore, 'filesAvailable' | 'pathContextKey'>,
	) {
		let previous: { nodeId: string; key: string } | null = null;
		$effect(() => {
			const nodeId = this.tree.nodeId;
			const key = this.nodes?.pathContextKey(nodeId) ?? nodeId;
			const browsingNode = this.browsingNode;
			const available = this.#filesAvailable(nodeId);
			untrack(() => {
				if (!available) this.tree.setNodeAvailable(false);
				if (previous?.nodeId === nodeId && previous.key !== key) this.tree.invalidateNodePaths();
				previous = { nodeId, key };
				if (browsingNode && available) this.tree.setNodeAvailable(true);
			});
		});
		$effect(() => {
			const pending = this.#pendingReveal;
			const response = this.tree.readyResponse;
			if (!pending || !response || !this.presentationVisible) return;
			if (!this.browsingNode && this.#projectState.kind !== 'available') return;
			untrack(() => {
				this.#pendingReveal = null;
				if (pending.nodeId !== this.tree.nodeId) return;
				const relativePath = filePathRelativeToTreeRoot(
					response.fileRootPath,
					pending.fileRootPath,
					pending.relativePath,
				);
				if (relativePath) void this.tree.revealFile(relativePath);
			});
		});
	}

	get browsingNode(): boolean {
		return this.#selectedNodeId !== null || this.#projectState.kind === 'absent';
	}

	get canGoToChatProject(): boolean {
		return this.#projectState.kind === 'available';
	}

	selectNode(nodeId: string): void {
		if (!this.#filesAvailable(nodeId)) return;
		this.#pendingReveal = null;
		this.#selectedNodeId = nodeId;
		this.tree.browseNode(nodeId);
	}

	goToChatProject(): void {
		const wasBrowsingNode = this.browsingNode;
		this.#selectedNodeId = null;
		this.#pendingReveal = null;
		this.setProjectState(this.#projectState);
		if (!wasBrowsingNode) void this.tree.goToChatProject();
	}

	revealFile(fileRootPath: string, relativePath: string, nodeId?: string | null): void {
		if (effectiveNodeId(nodeId) !== this.tree.nodeId) this.selectNode(effectiveNodeId(nodeId));
		this.#pendingReveal = { nodeId: effectiveNodeId(nodeId), fileRootPath, relativePath };
	}

	setProjectState(projectState: WorkspaceProjectState): void {
		const wasAbsent = this.#projectState.kind === 'absent';
		this.#projectState = projectState;
		if (this.#selectedNodeId !== null) return;
		if (projectState.kind === 'absent') {
			if (!wasAbsent || this.tree.effectiveProjectKey !== 'node:local') {
				this.#pendingReveal = null;
				this.#projectPath = null;
				this.tree.setProjectState(projectState);
				this.tree.browseNode('local');
			}
			this.tree.setNodeAvailable(this.#filesAvailable('local'));
			return;
		}
		const projectPath =
			projectState.kind === 'available'
				? projectState.project.projectPath
				: projectState.context.projectPath;
		if (projectPath !== this.#projectPath) this.#pendingReveal = null;
		this.#projectPath = projectPath;
		this.tree.setProjectState(projectState);
	}

	setPresentationVisible(visible: boolean): void {
		if (this.presentationVisible === visible) return;
		this.presentationVisible = visible;
		if (visible) this.tree.activate();
		else {
			this.#pendingReveal = null;
			this.tree.deactivate();
		}
	}

	dispose(): void {
		this.presentationVisible = false;
		this.#selectedNodeId = null;
		this.#pendingReveal = null;
		this.tree.reset();
	}

	#filesAvailable(nodeId: string): boolean {
		return this.nodes?.filesAvailable(nodeId) ?? nodeId === 'local';
	}
}

export interface SingletonControllerByKind {
	git: GitWorkbenchSurfaceController;
	'git-history': GitHistorySurfaceController;
	'git-compare': GitCompareSurfaceController;
	'pull-requests': PullRequestsStore;
	files: FilesSurfaceController;
	commit: CommitController;
	'chat-map': ChatMapController;
	'chat-canvas': CanvasController;
	'chat-board': ChatBoardController;
	tickets: TicketsController;
}

type SingletonControllerFactories = {
	[K in PortableSingletonKind]: () => SingletonControllerByKind[K];
};

interface OwnedSingletonController {
	controller: PortableSingletonController;
	destroyRoot: () => void;
}

export class SingletonSurfaceRegistry {
	#controllers = new Map<PortableSingletonKind, OwnedSingletonController>();
	readonly #factories: SingletonControllerFactories;
	#projectState: WorkspaceProjectState = { kind: 'absent' };
	#filesProjectState: WorkspaceProjectState = { kind: 'absent' };
	#visible: Record<PortableSingletonKind, boolean> = {
		git: false,
		'git-history': false,
		'git-compare': false,
		'pull-requests': false,
		files: false,
		commit: false,
		'chat-map': false,
		'chat-canvas': false,
		'chat-board': false,
		tickets: false,
	};
	#hasVisibleProjectSurface = $state(false);
	readonly #canvasExitGuard = new CanvasExitGuard(
		browserCanvasRecovery,
		() => this.chatCanvasIfPresent()?.session ?? null,
	);

	constructor(private readonly deps: SingletonSurfaceRegistryDeps) {
		this.#canvasExitGuard.activate();
		this.#factories = {
			tickets: () => {
				if (!this.deps.createTickets) throw new Error('Tickets factory is unavailable');
				return this.deps.createTickets();
			},
			git: () => new GitWorkbenchSurfaceController(this.deps),
			'git-history': () => new GitHistorySurfaceController(this.deps),
			'git-compare': () => new GitCompareSurfaceController(this.deps),
			files: () => new FilesSurfaceController(this.deps.executionNodes),
			commit: () => this.deps.createCommit(),
			'chat-map': () => new ChatMapController(),
			'chat-canvas': () => new CanvasController(),
			'chat-board': () => {
				if (!this.deps.createChatBoard) throw new Error('Chat Board factory is unavailable');
				return this.deps.createChatBoard();
			},
			'pull-requests': () => this.deps.createPullRequests(),
		};
	}

	gitWorkbench(): GitWorkbenchSurfaceController {
		return this.#controller('git');
	}

	gitHistory(): GitHistorySurfaceController {
		return this.#controller('git-history');
	}

	gitCompare(): GitCompareSurfaceController {
		return this.#controller('git-compare');
	}

	files(): FilesSurfaceController {
		return this.#controller('files');
	}

	filesIfPresent(): FilesSurfaceController | null {
		return (
			(this.#controllers.get('files')?.controller as FilesSurfaceController | undefined) ?? null
		);
	}

	chatMap(): ChatMapController {
		return this.#controller('chat-map');
	}

	chatCanvas(): CanvasController {
		return this.#controller('chat-canvas');
	}

	chatCanvasIfPresent(): CanvasController | null {
		return (
			(this.#controllers.get('chat-canvas')?.controller as CanvasController | undefined) ?? null
		);
	}

	chatBoard(): ChatBoardController {
		return this.#controller('chat-board');
	}

	tickets(): TicketsController {
		return this.#controller('tickets');
	}
	ticketsIfPresent(): TicketsController | null {
		return (this.#controllers.get('tickets')?.controller as TicketsController | undefined) ?? null;
	}

	commit(): CommitController {
		return this.#controller('commit');
	}

	commitIfPresent(): CommitController | null {
		return (this.#controllers.get('commit')?.controller as CommitController | undefined) ?? null;
	}

	pullRequests(): PullRequestsStore {
		return this.#controller('pull-requests');
	}

	setProjectState(projectState: WorkspaceProjectState, filesProjectState = projectState): void {
		this.#projectState = projectState;
		this.#filesProjectState = filesProjectState;
		for (const [kind, owned] of this.#controllers) {
			owned.controller.setProjectState(kind === 'files' ? filesProjectState : projectState);
		}
	}

	pruneGitNodes(nodeIds: ReadonlySet<string>): void {
		for (const { controller } of this.#controllers.values()) {
			if (
				controller instanceof GitWorkbenchSurfaceController ||
				controller instanceof CommitController ||
				controller instanceof PullRequestsStore
			)
				controller.pruneNodes(nodeIds);
			else if (
				controller instanceof GitHistorySurfaceController ||
				controller instanceof GitCompareSurfaceController
			)
				controller.target.pruneNodes(nodeIds);
		}
	}

	setPresentationVisible(kind: PortableSingletonKind, visible: boolean): void {
		if (this.#visible[kind] === visible) return;
		this.#visible[kind] = visible;
		this.#updateVisibleProjectSurface();
		this.#controllers.get(kind)?.controller.setPresentationVisible(visible);
	}

	get hasVisibleProjectSurface(): boolean {
		return this.#hasVisibleProjectSurface;
	}

	disposeSurface(kind: PortableSingletonKind): void {
		if (kind === 'tickets' && this.ticketsIfPresent()?.drafts.needsExitGuard) {
			this.setPresentationVisible(kind, false);
			return;
		}
		this.#destroySurface(kind);
	}

	#destroySurface(kind: PortableSingletonKind): void {
		this.#visible[kind] = false;
		this.#updateVisibleProjectSurface();
		const owned = this.#controllers.get(kind);
		if (!owned) return;
		this.#controllers.delete(kind);
		try {
			owned.controller.setPresentationVisible(false);
			owned.controller.dispose();
		} finally {
			owned.destroyRoot();
		}
	}

	#updateVisibleProjectSurface(): void {
		this.#hasVisibleProjectSurface = PORTABLE_SINGLETON_KINDS.some(
			(candidate) =>
				candidate !== 'chat-map' &&
				candidate !== 'chat-canvas' &&
				candidate !== 'chat-board' &&
				candidate !== 'tickets' &&
				this.#visible[candidate],
		);
	}

	destroy(): void {
		for (const kind of [...this.#controllers.keys()]) this.#destroySurface(kind);
		this.#canvasExitGuard.dispose();
	}

	#controller<K extends PortableSingletonKind>(kind: K): SingletonControllerByKind[K] {
		const existing = this.#controllers.get(kind);
		if (existing) return existing.controller as SingletonControllerByKind[K];
		let controller!: SingletonControllerByKind[K];
		// A registry-owned root keeps lazy rune state alive across presentation remounts.
		const destroyRoot = $effect.root(() => {
			controller = this.#factories[kind]();
			controller.setProjectState(kind === 'files' ? this.#filesProjectState : this.#projectState);
			controller.setPresentationVisible(this.#visible[kind]);
		});
		this.#controllers.set(kind, { controller, destroyRoot });
		return controller;
	}
}
