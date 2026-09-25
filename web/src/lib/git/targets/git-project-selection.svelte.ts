import { effectiveExecutorId } from '$shared/executors';
import type { GitProjectTarget } from '$shared/git-execution';
import type { ProjectUnavailableReason } from '$shared/project-resolution';
import type { ExecutorsStore } from '$lib/executors/executors-store.svelte.js';
import {
	ProjectResolutionStore,
	type ProjectResolutionLease,
	type ProjectResolutionSnapshot,
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
			project: GitProjectTarget & { effectiveProjectKey: string; executorContextKey?: string };
	  };

export interface GitProjectSelectionDeps {
	projectResolution: Pick<ProjectResolutionStore, 'retain'>;
	executors?: Pick<ExecutorsStore, 'gitAvailable' | 'gitContextKey' | 'onChanged'>;
	projectBasePath(executorId: string): string | null;
}

export class GitProjectSelectionController {
	projectState = $state.raw<GitProjectState>({ kind: 'absent' });
	showFolderDialog = $state(false);
	#chatProjectState = $state.raw<WorkspaceProjectState>({ kind: 'absent' });
	#pinnedTarget = $state.raw<GitProjectTarget | null>(null);
	#visible = false;
	#disposed = false;
	#generation = 0;
	#executorContextKey: string | null = null;
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
		this.#unsubscribe = this.#deps.executors?.onChanged(() => this.#executorChanged());
	}

	get followingChat(): boolean {
		return this.#pinnedTarget === null;
	}
	get chatId(): string | null {
		if (!this.followingChat) return null;
		const chat = this.#chatProjectState;
		if (chat.kind === 'absent') return null;
		return chat.kind === 'available' ? chat.project.chatId : chat.context.chatId;
	}
	get target(): GitProjectTarget | null {
		const project = this.projectState;
		if (project.kind === 'absent') return null;
		return project.kind === 'available' ? project.project : project.context;
	}
	get executorId(): string {
		return this.target?.executorId ?? 'local';
	}
	get projectPath(): string | null {
		return this.target?.projectPath ?? null;
	}
	get canGoToChatProject(): boolean {
		return this.#chatProjectState.kind === 'available';
	}

	setProjectState(project: WorkspaceProjectState): void {
		this.#chatProjectState = project;
		if (!this.followingChat) return;
		switch (project.kind) {
			case 'absent':
				this.#publish(project);
				break;
			case 'available':
				this.#publish({
					...project,
					project: { ...project.project, executorId: effectiveExecutorId(project.project.executorId) },
				});
				break;
			default:
				this.#publish({
					...project,
					context: { ...project.context, executorId: effectiveExecutorId(project.context.executorId) },
				});
		}
	}

	selectResolvedProject(target: GitProjectTarget): void {
		this.showFolderDialog = false;
		this.#cancelResolution();
		this.#pinnedTarget = target;
		this.#fallbackToBase = false;
		this.#executorContextKey = this.#contextKey(target.executorId);
		this.#publish({
			kind: 'available',
			project: {
				...target,
				effectiveProjectKey: target.projectPath,
				executorContextKey: this.#executorContextKey,
			},
		});
	}

	async selectExecutor(executorId: string, currentPath = this.projectPath): Promise<void> {
		if (!this.#available(executorId)) return;
		this.showFolderDialog = false;
		this.#cancelResolution();
		const projectPath = currentPath ?? this.#deps.projectBasePath(executorId) ?? '';
		this.#pinnedTarget = { executorId, projectPath };
		this.#executorContextKey = this.#contextKey(executorId);
		this.#fallbackToBase = true;
		this.#publish({ kind: 'resolving', context: this.#pinnedTarget });
		await this.#resolveSelection();
	}

	goToChatProject(): void {
		this.showFolderDialog = false;
		this.#cancelResolution();
		this.#pinnedTarget = null;
		this.#fallbackToBase = false;
		this.setProjectState(this.#chatProjectState);
	}

	setPresentationVisible(visible: boolean): void {
		this.#visible = visible;
		if (!visible) {
			this.showFolderDialog = false;
			this.#cancelResolution();
		} else if (this.#pinnedTarget && this.projectState.kind === 'resolving') {
			void this.#resolveSelection();
		}
	}

	async retry(): Promise<void> {
		if (this.#pinnedTarget) {
			this.#cancelResolution();
			this.#publish({ kind: 'resolving', context: this.#pinnedTarget });
			await this.#resolveSelection();
			return;
		}
		const chat = this.#chatProjectState;
		if (chat.kind === 'absent') return;
		const target = chat.kind === 'available' ? chat.project : chat.context;
		const lease = this.#deps.projectResolution.retain({ kind: 'chat', ...target });
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

	#executorChanged(): void {
		const target = this.#pinnedTarget;
		if (!target) return;
		const key = this.#contextKey(target.executorId);
		if (key === this.#executorContextKey) return;
		this.showFolderDialog = false;
		this.#executorContextKey = key;
		this.#cancelResolution();
		if (!this.#available(target.executorId)) {
			this.#publish({
				kind: 'request-failed',
				context: target,
				message: 'Git is unavailable on this executor.',
			});
			return;
		}
		this.#publish({ kind: 'resolving', context: target });
		void this.#resolveSelection();
	}

	async #resolveSelection(): Promise<void> {
		const target = this.#pinnedTarget;
		if (!target || !this.#visible || this.#disposed || this.#lease) return;
		const generation = this.#generation;
		const isCurrent = () => !this.#disposed && generation === this.#generation;
		let requestedTarget = target;
		try {
			if (!this.#available(target.executorId)) {
				throw new Error('Git is unavailable on this executor.');
			}
			if (!requestedTarget.projectPath) {
				throw new Error('The executor has no project base directory.');
			}
			let snapshot = await this.#resolvePath(requestedTarget, isCurrent);
			if (!isCurrent()) return;
			const baseProjectPath = this.#deps.projectBasePath(target.executorId);
			if (
				this.#fallbackToBase &&
				snapshot.kind === 'unavailable' &&
				(snapshot.reason === 'not-found' ||
					snapshot.reason === 'not-a-directory' ||
					snapshot.reason === 'outside-base') &&
				baseProjectPath &&
				baseProjectPath !== requestedTarget.projectPath
			) {
				requestedTarget = { executorId: target.executorId, projectPath: baseProjectPath };
				snapshot = await this.#resolvePath(requestedTarget, isCurrent);
				if (!isCurrent()) return;
			}
			this.#fallbackToBase = false;
			this.#pinnedTarget = requestedTarget;
			if (snapshot.kind === 'available') {
				this.#publish({
					kind: 'available',
					project: {
						...requestedTarget,
						effectiveProjectKey: snapshot.effectiveProjectKey,
						executorContextKey: this.#contextKey(target.executorId),
					},
				});
			} else {
				this.#publish({ ...snapshot, context: requestedTarget });
			}
		} catch (error) {
			if (!isCurrent()) return;
			this.#publish({
				kind: 'request-failed',
				context: requestedTarget,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async #resolvePath(
		target: GitProjectTarget,
		isCurrent: () => boolean,
	): Promise<ProjectResolutionSnapshot> {
		// A path-context change can invalidate the lease without changing the Git context.
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

	#available(executorId: string): boolean {
		return this.#deps.executors?.gitAvailable(executorId) ?? executorId === 'local';
	}
	#contextKey(executorId: string): string {
		return this.#deps.executors?.gitContextKey(executorId) ?? executorId;
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
