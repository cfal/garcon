import { effectiveNodeId } from '$shared/execution-nodes';
import type { GitProjectTarget } from '$shared/git-execution';
import type { ProjectUnavailableReason } from '$shared/project-resolution';
import type { ExecutionNodesStore } from '$lib/execution-nodes/execution-nodes-store.svelte.js';
import {
	ProjectResolutionStore,
	type ProjectResolutionLease,
} from '$lib/workspace/project-resolution-store.svelte.js';
import type { WorkspaceProjectState } from '$lib/workspace/workspace-context.svelte.js';

export type GitProjectState =
	| { kind: 'absent' }
	| { kind: 'unchecked'; context: GitProjectTarget }
	| { kind: 'resolving'; context: GitProjectTarget }
	| { kind: 'unavailable'; context: GitProjectTarget; reason: ProjectUnavailableReason }
	| { kind: 'request-failed'; context: GitProjectTarget; message: string }
	| {
			kind: 'available';
			project: GitProjectTarget & { effectiveProjectKey: string; nodeContextKey?: string };
	  };

export interface GitProjectSelectionDeps {
	projectResolution: Pick<ProjectResolutionStore, 'retain'>;
	nodes?: Pick<ExecutionNodesStore, 'gitAvailable' | 'gitContextKey' | 'onChanged'>;
	projectBasePath(nodeId: string): string | null;
}

export class GitProjectSelectionController {
	projectState = $state.raw<GitProjectState>({ kind: 'absent' });
	showFolderDialog = $state(false);
	#chat = $state.raw<WorkspaceProjectState>({ kind: 'absent' });
	#explicit = $state.raw<GitProjectTarget | null>(null);
	#visible = false;
	#disposed = false;
	#generation = 0;
	#nodeContextKey: string | null = null;
	#lease: ProjectResolutionLease | null = null;
	#fallbackToBase = false;
	readonly #unsubscribe: (() => void) | undefined;
	readonly #deps: GitProjectSelectionDeps;

	constructor(
		private readonly onChanged: (project: GitProjectState) => void,
		deps?: GitProjectSelectionDeps,
	) {
		this.#deps = deps ?? {
			projectResolution: new ProjectResolutionStore(),
			projectBasePath: () => null,
		};
		this.#unsubscribe = this.#deps.nodes?.onChanged(() => this.#nodeChanged());
	}

	get followingChat(): boolean {
		return this.#explicit === null;
	}
	get chatId(): string | null {
		if (!this.followingChat || this.#chat.kind === 'absent') return null;
		return this.#chat.kind === 'available' ? this.#chat.project.chatId : this.#chat.context.chatId;
	}
	get target(): GitProjectTarget | null {
		const project = this.projectState;
		if (project.kind === 'absent') return null;
		return project.kind === 'available' ? project.project : project.context;
	}
	get nodeId(): string {
		return this.target?.nodeId ?? 'local';
	}
	get projectPath(): string | null {
		return this.target?.projectPath ?? null;
	}
	get canGoToChatProject(): boolean {
		return this.#chat.kind === 'available';
	}

	setProjectState(project: WorkspaceProjectState): void {
		this.#chat = project;
		if (!this.followingChat) return;
		if (project.kind === 'absent') this.#publish(project);
		else if (project.kind === 'available') {
			this.#publish({
				...project,
				project: { ...project.project, nodeId: effectiveNodeId(project.project.nodeId) },
			});
		} else {
			this.#publish({
				...project,
				context: { ...project.context, nodeId: effectiveNodeId(project.context.nodeId) },
			});
		}
	}

	selectResolvedProject(target: GitProjectTarget): void {
		this.showFolderDialog = false;
		this.#cancelResolution();
		this.#explicit = target;
		this.#fallbackToBase = false;
		this.#nodeContextKey = this.#contextKey(target.nodeId);
		this.#publish({
			kind: 'available',
			project: {
				...target,
				effectiveProjectKey: target.projectPath,
				nodeContextKey: this.#nodeContextKey,
			},
		});
	}

	async selectNode(nodeId: string, currentPath = this.projectPath): Promise<void> {
		if (!this.#available(nodeId)) return;
		this.showFolderDialog = false;
		this.#cancelResolution();
		const projectPath = currentPath ?? this.#deps.projectBasePath(nodeId) ?? '';
		this.#explicit = { nodeId, projectPath };
		this.#nodeContextKey = this.#contextKey(nodeId);
		this.#fallbackToBase = true;
		this.#publish({ kind: 'resolving', context: this.#explicit });
		await this.#resolveSelection();
	}

	goToChatProject(): void {
		this.showFolderDialog = false;
		this.#cancelResolution();
		this.#explicit = null;
		this.#fallbackToBase = false;
		this.setProjectState(this.#chat);
	}

	setPresentationVisible(visible: boolean): void {
		this.#visible = visible;
		if (!visible) {
			this.showFolderDialog = false;
			this.#cancelResolution();
		} else if (this.#explicit && this.projectState.kind === 'resolving')
			void this.#resolveSelection();
	}

	async retry(): Promise<void> {
		if (this.#explicit) {
			this.#cancelResolution();
			this.#publish({ kind: 'resolving', context: this.#explicit });
			await this.#resolveSelection();
			return;
		}
		if (this.#chat.kind === 'absent') return;
		const chat = this.#chat.kind === 'available' ? this.#chat.project : this.#chat.context;
		const lease = this.#deps.projectResolution.retain({ kind: 'chat', ...chat });
		try {
			await lease.retry();
		} finally {
			lease.release();
		}
	}

	dispose(): void {
		this.showFolderDialog = false;
		this.#disposed = true;
		this.#unsubscribe?.();
		this.#cancelResolution();
	}

	#nodeChanged(): void {
		const target = this.#explicit;
		if (!target) return;
		const key = this.#contextKey(target.nodeId);
		if (key === this.#nodeContextKey) return;
		this.showFolderDialog = false;
		this.#nodeContextKey = key;
		this.#cancelResolution();
		if (!this.#available(target.nodeId)) {
			this.#publish({
				kind: 'request-failed',
				context: target,
				message: 'Git is unavailable on this execution node.',
			});
			return;
		}
		this.#publish({ kind: 'resolving', context: target });
		void this.#resolveSelection();
	}

	async #resolveSelection(): Promise<void> {
		const target = this.#explicit;
		if (!target || !this.#visible || this.#disposed || this.#lease) return;
		const generation = this.#generation;
		const current = () => !this.#disposed && generation === this.#generation;
		let requested = target;
		try {
			if (!this.#available(target.nodeId))
				throw new Error('Git is unavailable on this execution node.');
			if (!requested.projectPath)
				throw new Error('The execution node has no project base directory.');
			let snapshot = await this.#resolvePath(requested, current);
			if (!current()) return;
			const base = this.#deps.projectBasePath(target.nodeId);
			if (
				this.#fallbackToBase &&
				snapshot.kind === 'unavailable' &&
				snapshot.reason !== 'permission-denied' &&
				base &&
				base !== requested.projectPath
			) {
				requested = { nodeId: target.nodeId, projectPath: base };
				snapshot = await this.#resolvePath(requested, current);
				if (!current()) return;
			}
			this.#fallbackToBase = false;
			this.#explicit = requested;
			if (snapshot.kind === 'available') {
				this.#publish({
					kind: 'available',
					project: {
						...requested,
						effectiveProjectKey: snapshot.effectiveProjectKey,
						nodeContextKey: this.#contextKey(target.nodeId),
					},
				});
			} else this.#publish({ ...snapshot, context: requested });
		} catch (error) {
			if (current())
				this.#publish({
					kind: 'request-failed',
					context: requested,
					message: error instanceof Error ? error.message : String(error),
				});
		}
	}

	async #resolvePath(target: GitProjectTarget, isCurrent: () => boolean) {
		while (true) {
			const lease = this.#deps.projectResolution.retain({ kind: 'path', ...target });
			this.#lease = lease;
			try {
				await lease.resolve();
				const snapshot = lease.snapshot;
				if (snapshot.kind !== 'unchecked' || !isCurrent()) return snapshot;
			} finally {
				lease.release();
				if (this.#lease === lease) this.#lease = null;
			}
		}
	}

	#available(nodeId: string): boolean {
		return this.#deps.nodes?.gitAvailable(nodeId) ?? nodeId === 'local';
	}
	#contextKey(nodeId: string): string {
		return this.#deps.nodes?.gitContextKey(nodeId) ?? nodeId;
	}
	#publish(project: GitProjectState): void {
		this.projectState = project;
		this.onChanged(project);
	}
	#cancelResolution(): void {
		this.#generation++;
		this.#lease?.release();
		this.#lease = null;
	}
}
