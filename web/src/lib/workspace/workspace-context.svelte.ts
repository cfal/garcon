import type { ChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte.js';
import type { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte';
import type { ProjectTarget, ProjectUnavailableReason } from '$shared/project-resolution';
import type { ProjectResolutionStore } from './project-resolution-store.svelte.js';
import { effectiveExecutorId } from '$shared/executors';
import type { ExecutorsStore } from '$lib/executors/executors-store.svelte.js';

export interface WorkspaceContext {
	executorId?: string;
	chatId: string;
	projectPath: string;
}

export interface AvailableWorkspaceProject extends WorkspaceContext {
	effectiveProjectKey: string;
	executorContextKey?: string;
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
		private readonly modelCatalog: Pick<ModelCatalogStore, 'forExecutor'>,
		private readonly projectResolution: Pick<ProjectResolutionStore, 'snapshotFor'>,
		private readonly executors?: Pick<
			ExecutorsStore,
			'filesAvailable' | 'gitAvailable' | 'gitContextKey'
		>,
	) {}

	get current(): WorkspaceContext | null {
		const chat = this.sessions.selectedChat;
		if (!chat) return null;
		return {
			executorId: effectiveExecutorId(chat.executorId),
			chatId: chat.id,
			projectPath: chat.projectPath,
		};
	}

	get currentProject(): AvailableWorkspaceProject | null {
		const project = this.projectState;
		return project.kind === 'available' ? project.project : null;
	}

	get projectState(): WorkspaceProjectState {
		const current = this.current;
		if (
			current &&
			!(this.executors?.gitAvailable(current.executorId) ?? effectiveExecutorId(current.executorId) === 'local')
		) {
			return {
				kind: 'request-failed',
				context: current,
				message: 'Git is unavailable on this executor.',
			};
		}
		const project = this.#resolvedProjectState();
		return project.kind === 'available'
			? {
					...project,
					project: {
						...project.project,
						executorContextKey: this.executors?.gitContextKey(current?.executorId),
					},
				}
			: project;
	}

	get filesProjectState(): WorkspaceProjectState {
		const current = this.current;
		if (
			current &&
			!(this.executors?.filesAvailable(current.executorId) ?? effectiveExecutorId(current.executorId) === 'local')
		) {
			return {
				kind: 'request-failed',
				context: current,
				message: 'Files are unavailable on this executor.',
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
			? { kind: 'path', executorId: effectiveExecutorId(chat.executorId), projectPath: chat.projectPath }
			: {
					kind: 'chat',
					executorId: effectiveExecutorId(chat.executorId),
					chatId: chat.id,
					projectPath: chat.projectPath,
				};
	}

	get canUpdateProjectPath(): boolean {
		const chat = this.sessions.selectedChat;
		return chat
			? this.modelCatalog.forExecutor(chat.executorId).supportsUpdateProjectPath(chat.agentId)
			: false;
	}
}

export function createWorkspaceContextStore(
	sessions: Pick<ChatSessionsStore, 'selectedChat'>,
	modelCatalog: Pick<ModelCatalogStore, 'forExecutor'>,
	projectResolution: Pick<ProjectResolutionStore, 'snapshotFor'>,
	executors?: Pick<ExecutorsStore, 'filesAvailable' | 'gitAvailable' | 'gitContextKey'>,
): WorkspaceContextStore {
	return new WorkspaceContextStore(sessions, modelCatalog, projectResolution, executors);
}
