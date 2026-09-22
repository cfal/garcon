import type { GitProjectTarget } from '$lib/api/git-client.js';
import { gitProjectKey } from '$lib/git/targets/git-target.js';
import { effectiveNodeId } from '$shared/execution-nodes';
// Owns the GitHub pull request viewer's PR list for the
// active project plus the currently selected PR's detail (diff + threads).
// Selecting a PR loads its detail lazily; generation guards drop stale
// responses when the project or selection changes mid-flight.

import {
	getPullRequest,
	getPullRequests,
	type PullRequestDetail,
	type PullRequestSummary,
} from '$lib/api/pull-requests.js';
import * as m from '$lib/paraglide/messages.js';
import type { WorkspaceProjectState } from '$lib/workspace/workspace-context.svelte.js';
import type { PortableSingletonController } from '$lib/workspace/portable-singleton-controller.js';
import { errorMessage } from '$lib/utils/error-message.js';

export interface PullRequestsStoreDeps {
	notifyError?: (message: string) => void;
}

interface PullRequestProjectSnapshot {
	project: GitProjectTarget;
	pulls: PullRequestSummary[];
	repoName: string | null;
	hasLoaded: boolean;
	selectedNumber: number | null;
	detail: PullRequestDetail | null;
	accessedAt: number;
}

export class PullRequestsStore implements PortableSingletonController {
	#project = $state<GitProjectTarget | null>(null);
	#nodeContextKey: string | null = null;
	#capability: { nodeId: string; hasChecked: boolean; available: boolean } | null = null;
	#effectiveProjectKey = $state<string | null>(null);
	#visible = $state(false);
	#projectIdentityPending = $state(false);
	#listGeneration = 0;
	#detailGeneration = 0;
	#listController: AbortController | null = null;
	#detailController: AbortController | null = null;
	#snapshots = new Map<string, PullRequestProjectSnapshot>();
	#needsRefresh = false;
	#detailNeedsRefresh = false;
	#deps: PullRequestsStoreDeps;
	capabilityState = $state<'pending' | 'available' | 'unavailable'>('pending');

	pulls = $state<PullRequestSummary[]>([]);
	repoName = $state<string | null>(null);
	isLoading = $state(false);
	loadError = $state<string | null>(null);
	hasLoaded = $state(false);
	collapsed = $state(false);

	selectedNumber = $state<number | null>(null);
	detail = $state<PullRequestDetail | null>(null);
	isDetailLoading = $state(false);
	detailError = $state<string | null>(null);

	constructor(deps: PullRequestsStoreDeps = {}) {
		this.#deps = deps;
	}

	get projectPath(): string | null {
		return this.#project?.projectPath ?? null;
	}

	get nodeId(): string {
		return this.#project?.nodeId ?? 'local';
	}

	get effectiveProjectKey(): string | null {
		return this.#effectiveProjectKey;
	}

	get projectIdentityPending(): boolean {
		return this.#projectIdentityPending;
	}

	get hasSelection(): boolean {
		return this.selectedNumber !== null;
	}

	get selectedSummary(): PullRequestSummary | null {
		return this.pulls.find((pr) => pr.number === this.selectedNumber) ?? null;
	}

	setCapability(nodeId: string, hasChecked: boolean, available: boolean): void {
		this.#capability = { nodeId, hasChecked, available };
		const next =
			nodeId !== this.nodeId || !hasChecked ? 'pending' : available ? 'available' : 'unavailable';
		if (next === this.capabilityState) return;
		this.capabilityState = next;
		if (next !== 'available') {
			this.#suspendRequests();
			return;
		}
		if (
			!this.#projectIdentityPending &&
			this.#visible &&
			this.#project &&
			(!this.hasLoaded || this.#needsRefresh)
		) {
			void this.refresh();
		}
	}

	setProjectState(projectState: WorkspaceProjectState): void {
		if (projectState.kind === 'unchecked' || projectState.kind === 'resolving') {
			this.#projectIdentityPending = true;
			return;
		}
		if (projectState.kind === 'unavailable' || projectState.kind === 'request-failed') {
			this.#projectIdentityPending = true;
			this.#nodeContextKey = null;
			this.#detailNeedsRefresh = true;
			this.#suspendRequests();
			return;
		}
		this.#projectIdentityPending = false;
		if (projectState.kind === 'absent') {
			this.setProject(null, null);
			return;
		}
		const { project } = projectState;
		const nodeContextKey = project.nodeContextKey ?? null;
		if (nodeContextKey !== this.#nodeContextKey) {
			this.#suspendRequests();
			this.#detailNeedsRefresh = true;
			this.#nodeContextKey = nodeContextKey;
		}
		this.setProject(
			{ nodeId: effectiveNodeId(project.nodeId), projectPath: project.projectPath },
			project.effectiveProjectKey,
		);
		this.#activateIfNeeded();
	}

	// Points the store at a project. Clears state and reloads when it changes.
	setProject(
		project: GitProjectTarget | null,
		effectiveProjectKey: string | null = project ? gitProjectKey(project) : null,
	): void {
		if (
			effectiveProjectKey === this.#effectiveProjectKey &&
			project?.nodeId === this.#project?.nodeId
		) {
			if (project?.projectPath !== this.#project?.projectPath) this.#project = project;
			return;
		}
		this.#listController?.abort();
		this.#detailController?.abort();
		this.#saveSnapshot();
		this.#listController = null;
		this.#detailController = null;
		this.#project = project;
		this.#effectiveProjectKey = effectiveProjectKey;
		this.#listGeneration++;
		this.pulls = [];
		this.repoName = null;
		this.hasLoaded = false;
		this.loadError = null;
		this.clearSelection();
		if (this.#capability) {
			const { nodeId, hasChecked, available } = this.#capability;
			this.capabilityState =
				nodeId !== this.nodeId || !hasChecked ? 'pending' : available ? 'available' : 'unavailable';
		}
		if (project && effectiveProjectKey)
			this.#restoreSnapshot(JSON.stringify([project.nodeId, effectiveProjectKey]));
		this.#needsRefresh = Boolean(project);
		this.#detailNeedsRefresh = Boolean(project);
		this.#activateIfNeeded();
	}

	setPresentationVisible(visible: boolean): void {
		if (visible === this.#visible) return;
		this.#visible = visible;
		if (!visible) {
			this.#suspendRequests();
			return;
		}
		this.#activateIfNeeded();
	}

	toggleCollapsed(): void {
		this.collapsed = !this.collapsed;
	}

	async refresh(): Promise<void> {
		const project = this.#project;
		if (
			this.#projectIdentityPending ||
			!project ||
			!this.#visible ||
			this.capabilityState !== 'available'
		)
			return;
		this.#listController?.abort();
		const controller = new AbortController();
		this.#listController = controller;
		const generation = ++this.#listGeneration;
		this.isLoading = true;
		this.loadError = null;
		try {
			const result = await getPullRequests(project, { signal: controller.signal });
			if (controller.signal.aborted || generation !== this.#listGeneration) return;
			this.pulls = result.pulls;
			this.repoName = result.repo?.nameWithOwner ?? null;
			this.hasLoaded = true;
		} catch (error) {
			if (controller.signal.aborted) return;
			if (generation !== this.#listGeneration) return;
			this.loadError = errorMessage(error, m.pull_requests_load_failed());
			this.hasLoaded = true;
		} finally {
			if (generation === this.#listGeneration) {
				this.isLoading = false;
				if (!controller.signal.aborted) this.#needsRefresh = false;
				if (this.#listController === controller) this.#listController = null;
			}
		}
	}

	async select(number: number): Promise<void> {
		if (this.#projectIdentityPending || !this.#project || this.capabilityState !== 'available')
			return;
		this.selectedNumber = number;
		await this.loadDetail(number);
	}

	async loadDetail(number: number): Promise<void> {
		const project = this.#project;
		if (
			this.#projectIdentityPending ||
			!project ||
			!this.#visible ||
			this.capabilityState !== 'available'
		)
			return;
		this.#detailController?.abort();
		const controller = new AbortController();
		this.#detailController = controller;
		const generation = ++this.#detailGeneration;
		this.isDetailLoading = true;
		this.detailError = null;
		if (this.detail?.number !== number) this.detail = null;
		try {
			const detail = await getPullRequest(project, number, { signal: controller.signal });
			if (controller.signal.aborted || generation !== this.#detailGeneration) return;
			this.detail = detail;
			this.#detailNeedsRefresh = false;
		} catch (error) {
			if (controller.signal.aborted) return;
			if (generation !== this.#detailGeneration) return;
			const message = errorMessage(error, m.pull_request_load_failed());
			this.detailError = message;
			this.#deps.notifyError?.(message);
		} finally {
			if (generation === this.#detailGeneration) {
				this.isDetailLoading = false;
				if (this.#detailController === controller) this.#detailController = null;
			}
		}
	}

	clearSelection(): void {
		this.#detailController?.abort();
		this.#detailController = null;
		this.#detailGeneration++;
		this.selectedNumber = null;
		this.detail = null;
		this.detailError = null;
		this.isDetailLoading = false;
	}

	dispose(): void {
		this.#listController?.abort();
		this.#detailController?.abort();
		this.#listController = null;
		this.#detailController = null;
		this.#listGeneration += 1;
		this.#detailGeneration += 1;
		this.#project = null;
		this.#effectiveProjectKey = null;
		this.#projectIdentityPending = false;
		this.#snapshots.clear();
		this.#needsRefresh = false;
		this.#visible = false;
		this.pulls = [];
		this.repoName = null;
		this.isLoading = false;
		this.loadError = null;
		this.hasLoaded = false;
		this.collapsed = false;
		this.selectedNumber = null;
		this.detail = null;
		this.isDetailLoading = false;
		this.detailError = null;
	}

	pruneNodes(nodeIds: ReadonlySet<string>): void {
		for (const [key, snapshot] of this.#snapshots) {
			if (!nodeIds.has(snapshot.project.nodeId)) this.#snapshots.delete(key);
		}
		if (this.#project && !nodeIds.has(this.nodeId)) {
			this.#suspendRequests();
			this.#projectIdentityPending = true;
			this.detail = null;
			this.pulls = [];
		}
	}

	#activateIfNeeded(): void {
		if (
			this.#projectIdentityPending ||
			!this.#visible ||
			!this.#project ||
			this.capabilityState !== 'available'
		)
			return;
		if (!this.#listController && (!this.hasLoaded || this.#needsRefresh)) void this.refresh();
		if (
			this.selectedNumber !== null &&
			(this.detail?.number !== this.selectedNumber || this.#detailNeedsRefresh) &&
			!this.isDetailLoading
		) {
			void this.loadDetail(this.selectedNumber);
		}
	}

	#suspendRequests(): void {
		this.#listController?.abort();
		this.#detailController?.abort();
		this.#listController = null;
		this.#detailController = null;
		this.#listGeneration += 1;
		this.#detailGeneration += 1;
		this.isLoading = false;
		this.isDetailLoading = false;
		this.#needsRefresh = Boolean(this.#project);
	}

	#saveSnapshot(): void {
		const effectiveProjectKey = this.#effectiveProjectKey;
		const project = this.#project;
		if (!effectiveProjectKey || !project) return;
		const key = JSON.stringify([project.nodeId, effectiveProjectKey]);
		this.#snapshots.delete(key);
		this.#snapshots.set(key, {
			project,
			pulls: this.pulls,
			repoName: this.repoName,
			hasLoaded: this.hasLoaded,
			selectedNumber: this.selectedNumber,
			detail: this.detail,
			accessedAt: Date.now(),
		});
		while (this.#snapshots.size > 8) {
			const oldest = this.#snapshots.keys().next().value;
			if (!oldest) break;
			this.#snapshots.delete(oldest);
		}
	}

	#restoreSnapshot(effectiveProjectKey: string): void {
		const snapshot = this.#snapshots.get(effectiveProjectKey);
		if (!snapshot) return;
		this.#snapshots.delete(effectiveProjectKey);
		this.#snapshots.set(effectiveProjectKey, { ...snapshot, accessedAt: Date.now() });
		this.pulls = snapshot.pulls;
		this.repoName = snapshot.repoName;
		this.hasLoaded = snapshot.hasLoaded;
		this.selectedNumber = snapshot.selectedNumber;
		this.detail = snapshot.detail;
	}
}

export function createPullRequestsStore(deps: PullRequestsStoreDeps = {}): PullRequestsStore {
	return new PullRequestsStore(deps);
}
