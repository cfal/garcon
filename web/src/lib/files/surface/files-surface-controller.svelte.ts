import { untrack } from 'svelte';
import { effectiveExecutorId } from '$shared/executors';
import { FileTreeStore } from '$lib/files/tree/file-tree.svelte.js';
import { filePathRelativeToTreeRoot } from '$lib/files/tree/file-tree-path.js';
import type { WorkspaceProjectState } from '$lib/workspace/workspace-context.svelte.js';
import type { PortableSingletonController } from '$lib/workspace/portable-singleton-controller.js';
import type { ExecutorsStore } from '$lib/executors/executors-store.svelte.js';
import {
	resolveExecutorServiceNotice,
	type ExecutorServiceNotice,
} from '$lib/executors/executor-service-notice.js';

export type FilesExecutorsPort = Pick<
	ExecutorsStore,
	'filesAvailable' | 'gitAvailable' | 'pathContextKey' | 'isReady' | 'hasSnapshot' | 'get' | 'label'
>;

export class FilesSurfaceController implements PortableSingletonController {
	readonly tree = new FileTreeStore();
	presentationVisible = $state(false);
	#projectState = $state.raw<WorkspaceProjectState>({ kind: 'absent' });
	#selectedExecutorId = $state<string | null>(null);
	#projectPath: string | null = null;
	#pendingReveal = $state.raw<{
		executorId: string;
		fileRootPath: string;
		relativePath: string;
	} | null>(null);

	constructor(private readonly executors?: FilesExecutorsPort) {
		let previous: { executorId: string; key: string } | null = null;
		$effect(() => {
			const executorId = this.tree.executorId;
			const key = this.executors?.pathContextKey(executorId) ?? executorId;
			const browsingExecutor = this.browsingExecutor;
			const available = this.#filesAvailable(executorId);
			untrack(() => {
				if (!available) this.tree.setExecutorAvailable(false);
				if (previous?.executorId === executorId && previous.key !== key) this.tree.invalidateExecutorPaths();
				previous = { executorId, key };
				if (browsingExecutor && available) this.tree.setExecutorAvailable(true);
			});
		});
		$effect(() => {
			const pending = this.#pendingReveal;
			const response = this.tree.readyResponse;
			if (!pending || !response || !this.presentationVisible) return;
			if (!this.browsingExecutor && this.#projectState.kind !== 'available') return;
			untrack(() => {
				this.#pendingReveal = null;
				if (pending.executorId !== this.tree.executorId) return;
				const relativePath = filePathRelativeToTreeRoot(
					response.fileRootPath,
					pending.fileRootPath,
					pending.relativePath,
				);
				if (relativePath) void this.tree.revealFile(relativePath);
			});
		});
	}

	get browsingExecutor(): boolean {
		return this.#selectedExecutorId !== null || this.#projectState.kind === 'absent';
	}

	get canGoToChatProject(): boolean {
		return this.#projectState.kind === 'available';
	}

	get serviceNotice(): ExecutorServiceNotice | null {
		return this.executors
			? resolveExecutorServiceNotice(this.executors, this.tree.executorId, 'files')
			: null;
	}

	selectExecutor(executorId: string): void {
		if (!this.#filesAvailable(executorId)) return;
		this.#pendingReveal = null;
		this.#selectedExecutorId = executorId;
		this.tree.browseExecutor(executorId);
	}

	goToChatProject(): void {
		const wasBrowsingExecutor = this.browsingExecutor;
		this.#selectedExecutorId = null;
		this.#pendingReveal = null;
		this.setProjectState(this.#projectState);
		if (!wasBrowsingExecutor) void this.tree.goToChatProject();
	}

	refreshForExecutorChange(executorId: string): void {
		if (this.tree.executorId === executorId) void this.tree.refresh();
	}

	revealFile(fileRootPath: string, relativePath: string, executorId?: string | null): void {
		if (effectiveExecutorId(executorId) !== this.tree.executorId) this.selectExecutor(effectiveExecutorId(executorId));
		this.#pendingReveal = { executorId: effectiveExecutorId(executorId), fileRootPath, relativePath };
	}

	setProjectState(projectState: WorkspaceProjectState): void {
		const wasAbsent = this.#projectState.kind === 'absent';
		this.#projectState = projectState;
		if (this.#selectedExecutorId !== null) return;
		if (projectState.kind === 'absent') {
			if (!wasAbsent || this.tree.effectiveProjectKey !== 'executor:local') {
				this.#pendingReveal = null;
				this.#projectPath = null;
				this.tree.setProjectState(projectState);
				this.tree.browseExecutor('local');
			}
			this.tree.setExecutorAvailable(this.#filesAvailable('local'));
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
		this.#selectedExecutorId = null;
		this.#pendingReveal = null;
		this.tree.reset();
	}

	#filesAvailable(executorId: string): boolean {
		return this.executors?.filesAvailable(executorId) ?? executorId === 'local';
	}
}
