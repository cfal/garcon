import type { ChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte.js';
import type { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte';
import type { ProjectTarget, ProjectUnavailableReason } from '$shared/project-resolution';
import type { ProjectResolutionStore } from './project-resolution-store.svelte.js';
import { effectiveNodeId } from '$shared/execution-nodes';
import type { ExecutionNodesStore } from '$lib/execution-nodes/execution-nodes-store.svelte.js';

export interface WorkspaceContext {
	nodeId?: string;
	chatId: string;
	projectPath: string;
}

export interface AvailableWorkspaceProject extends WorkspaceContext {
	effectiveProjectKey: string;
}

export type WorkspaceProjectState =
	| { kind: 'absent' }
	| { kind: 'unchecked'; context: WorkspaceContext }
	| { kind: 'resolving'; context: WorkspaceContext }
	| { kind: 'unavailable'; context: WorkspaceContext; reason: ProjectUnavailableReason }
	| { kind: 'request-failed'; context: WorkspaceContext; message: string }
	| { kind: 'available'; project: AvailableWorkspaceProject };

export class WorkspaceContextStore {
	constructor(
		private readonly sessions: Pick<ChatSessionsStore, 'selectedChat'>,
		private readonly modelCatalog: Pick<ModelCatalogStore, 'forNode'>,
		private readonly projectResolution: Pick<ProjectResolutionStore, 'snapshotFor'>,
		private readonly nodes?: Pick<ExecutionNodesStore, 'filesAvailable'>,
	) {}

	get current(): WorkspaceContext | null {
		const chat = this.sessions.selectedChat;
		if (!chat) return null;
		return {
			nodeId: effectiveNodeId(chat.nodeId),
			chatId: chat.id,
			projectPath: chat.projectPath,
		};
	}

	get currentProject(): AvailableWorkspaceProject | null {
		const current = this.current;
		const target = this.currentTarget;
		if (!current || !target) return null;
		if (effectiveNodeId(current.nodeId) !== 'local') return null;
		const resolution = this.projectResolution.snapshotFor(target);
		if (resolution.kind !== 'available') return null;
		return { ...current, effectiveProjectKey: resolution.effectiveProjectKey };
	}

	get projectState(): WorkspaceProjectState {
		const current = this.current;
		if (current && effectiveNodeId(current.nodeId) !== 'local') {
			return {
				kind: 'request-failed',
				context: current,
				message: 'Git and terminals are unavailable on remote execution nodes.',
			};
		}
		return this.#resolvedProjectState();
	}

	get filesProjectState(): WorkspaceProjectState {
		const current = this.current;
		if (
			current &&
			!(this.nodes?.filesAvailable(current.nodeId) ?? effectiveNodeId(current.nodeId) === 'local')
		) {
			return {
				kind: 'request-failed',
				context: current,
				message: 'Files are unavailable on this execution node.',
			};
		}
		return this.#resolvedProjectState();
	}

	#resolvedProjectState(): WorkspaceProjectState {
		const current = this.current;
		const target = this.currentTarget;
		if (!current || !target) return { kind: 'absent' };
		const resolution = this.projectResolution.snapshotFor(target);
		switch (resolution.kind) {
			case 'available':
				return {
					kind: 'available',
					project: { ...current, effectiveProjectKey: resolution.effectiveProjectKey },
				};
			case 'unavailable':
				return { kind: 'unavailable', context: current, reason: resolution.reason };
			case 'request-failed':
				return { kind: 'request-failed', context: current, message: resolution.message };
			case 'unchecked':
			case 'resolving':
				return { kind: resolution.kind, context: current };
		}
	}

	get currentTarget(): ProjectTarget | null {
		const chat = this.sessions.selectedChat;
		if (!chat) return null;
		return chat.status === 'draft'
			? { kind: 'path', nodeId: effectiveNodeId(chat.nodeId), projectPath: chat.projectPath }
			: {
					kind: 'chat',
					nodeId: effectiveNodeId(chat.nodeId),
					chatId: chat.id,
					projectPath: chat.projectPath,
				};
	}

	get canUpdateProjectPath(): boolean {
		const chat = this.sessions.selectedChat;
		return chat
			? this.modelCatalog.forNode(chat.nodeId).supportsUpdateProjectPath(chat.agentId)
			: false;
	}
}

export function createWorkspaceContextStore(
	sessions: Pick<ChatSessionsStore, 'selectedChat'>,
	modelCatalog: Pick<ModelCatalogStore, 'forNode'>,
	projectResolution: Pick<ProjectResolutionStore, 'snapshotFor'>,
	nodes?: Pick<ExecutionNodesStore, 'filesAvailable'>,
): WorkspaceContextStore {
	return new WorkspaceContextStore(sessions, modelCatalog, projectResolution, nodes);
}
