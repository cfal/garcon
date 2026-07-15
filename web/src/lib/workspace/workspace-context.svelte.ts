import type { ChatSessionsStore } from '$lib/stores/chat-sessions.svelte';
import type { ModelCatalogStore } from '$lib/stores/model-catalog.svelte';

export interface WorkspaceContext {
	chatId: string;
	projectPath: string;
	effectiveProjectKey: string | null;
}

export interface AvailableWorkspaceProject extends WorkspaceContext {
	effectiveProjectKey: string;
}

export type WorkspaceProjectState =
	| { kind: 'absent' }
	| { kind: 'resolving'; context: WorkspaceContext }
	| { kind: 'available'; project: AvailableWorkspaceProject };

export class WorkspaceContextStore {
	constructor(
		private readonly sessions: Pick<ChatSessionsStore, 'selectedChat'>,
		private readonly modelCatalog: Pick<ModelCatalogStore, 'supportsUpdateProjectPath'>,
	) {}

	get current(): WorkspaceContext | null {
		const chat = this.sessions.selectedChat;
		if (!chat) return null;
		return {
			chatId: chat.id,
			projectPath: chat.projectPath,
			effectiveProjectKey: chat.effectiveProjectKey,
		};
	}

	get currentProject(): AvailableWorkspaceProject | null {
		const current = this.current;
		if (!current?.effectiveProjectKey) return null;
		return { ...current, effectiveProjectKey: current.effectiveProjectKey };
	}

	get projectState(): WorkspaceProjectState {
		const current = this.current;
		if (!current) return { kind: 'absent' };
		const project = this.currentProject;
		return project ? { kind: 'available', project } : { kind: 'resolving', context: current };
	}

	get canUpdateProjectPath(): boolean {
		const chat = this.sessions.selectedChat;
		return chat ? this.modelCatalog.supportsUpdateProjectPath(chat.agentId) : false;
	}
}

export function createWorkspaceContextStore(
	sessions: Pick<ChatSessionsStore, 'selectedChat'>,
	modelCatalog: Pick<ModelCatalogStore, 'supportsUpdateProjectPath'>,
): WorkspaceContextStore {
	return new WorkspaceContextStore(sessions, modelCatalog);
}
