import type { ChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte.js';
import type { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte';
import type { ProjectTarget, ProjectUnavailableReason } from '$shared/project-resolution';
import type { ProjectResolutionStore } from './project-resolution-store.svelte.js';

export interface WorkspaceContext {
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
		private readonly modelCatalog: Pick<ModelCatalogStore, 'supportsUpdateProjectPath'>,
		private readonly projectResolution: Pick<ProjectResolutionStore, 'snapshotFor'>,
	) {}

	get current(): WorkspaceContext | null {
		const chat = this.sessions.selectedChat;
		if (!chat) return null;
		return {
			chatId: chat.id,
			projectPath: chat.projectPath,
		};
	}

	get currentProject(): AvailableWorkspaceProject | null {
		const current = this.current;
		const target = this.currentTarget;
		if (!current || !target) return null;
		const resolution = this.projectResolution.snapshotFor(target);
		if (resolution.kind !== 'available') return null;
		return { ...current, effectiveProjectKey: resolution.effectiveProjectKey };
	}

	get projectState(): WorkspaceProjectState {
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
			? { kind: 'path', projectPath: chat.projectPath }
			: { kind: 'chat', chatId: chat.id, projectPath: chat.projectPath };
	}

	get canUpdateProjectPath(): boolean {
		const chat = this.sessions.selectedChat;
		return chat ? this.modelCatalog.supportsUpdateProjectPath(chat.agentId) : false;
	}
}

export function createWorkspaceContextStore(
	sessions: Pick<ChatSessionsStore, 'selectedChat'>,
	modelCatalog: Pick<ModelCatalogStore, 'supportsUpdateProjectPath'>,
	projectResolution: Pick<ProjectResolutionStore, 'snapshotFor'>,
): WorkspaceContextStore {
	return new WorkspaceContextStore(sessions, modelCatalog, projectResolution);
}
