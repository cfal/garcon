import { projectTargetKey, type ProjectTarget, type ProjectUnavailableReason } from '$shared/project-resolution';
import { effectiveExecutorId } from '$shared/executors';
import { isCustomProviderSelectionAvailable } from '$lib/agents/provider-selection.js';
import type { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte.js';
import type { AgentState } from '$lib/chat/conversation/agent-state.svelte.js';
import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types.js';
import type { ExecutorsStore } from '$lib/executors/executors-store.svelte.js';
import {
	resolveExecutorAvailabilityNotice,
	type ExecutorAvailabilityNotice,
} from '$lib/executors/executor-service-notice.js';
import type { ProjectResolutionSnapshot, ProjectResolutionStore } from '$lib/workspace/project-resolution-store.svelte.js';

export type ComposerAvailabilityNotice =
	| ExecutorAvailabilityNotice
	| {
			readonly kind: 'project-unavailable';
			readonly projectPath: string;
			readonly reason?: ProjectUnavailableReason;
			readonly requestError?: string;
	  }
	| { readonly kind: 'catalog-failed'; readonly message: string }
	| { readonly kind: 'provider-unavailable' };

export interface ComposerAvailabilityNoticePresentation {
	readonly chatId: string;
	readonly notice: ComposerAvailabilityNotice;
	readonly onRetryProject: () => void;
	readonly onChooseProjectFolder?: () => void;
	readonly onRetryCatalog: () => void;
}

export interface ComposerAvailabilityInput {
	readonly executorId: string;
	readonly executors: Pick<ExecutorsStore, 'isReady' | 'hasSnapshot' | 'get' | 'label'>;
	readonly projectTarget: ProjectTarget | null;
	readonly projectResolution: ProjectResolutionSnapshot;
	readonly catalog: Pick<ModelCatalogStore, 'isValidated' | 'error'>;
	readonly providerAvailable: boolean;
}

export function composerProjectTarget(
	chat: ChatSessionRecord | null,
	execution?: { executorId: string; projectPath: string },
): ProjectTarget | null {
	if (!chat?.projectPath) return null;
	if (execution && (
		execution.executorId !== effectiveExecutorId(chat.executorId) ||
		execution.projectPath !== chat.projectPath
	)) {
		return { kind: 'path', ...execution };
	}
	return chat.status === 'draft'
		? { kind: 'path', executorId: chat.executorId, projectPath: chat.projectPath }
		: { kind: 'chat', chatId: chat.id, executorId: chat.executorId, projectPath: chat.projectPath };
}

interface ComposerAvailabilityPresentationInput {
	readonly chat: ChatSessionRecord | null;
	readonly visible: boolean;
	readonly agent: Pick<AgentState, 'executorId' | 'projectPath' | 'agentId' | 'model' | 'apiProviderId' | 'modelEndpointId'>;
	readonly executors: ComposerAvailabilityInput['executors'];
	readonly catalog: Pick<ModelCatalogStore, 'forExecutor'>;
	readonly projects: Pick<ProjectResolutionStore, 'snapshotFor' | 'retain'>;
	readonly onChooseProjectFolder?: (chatId: string) => void;
}

export function presentComposerAvailabilityNotice(
	input: ComposerAvailabilityPresentationInput,
): ComposerAvailabilityNoticePresentation | null {
	const { chat, visible, agent, catalog, projects } = input;
	if (!chat || !visible) return null;
	const executorId = agent.executorId;
	const executorCatalog = catalog.forExecutor(executorId);
	const target = composerProjectTarget(chat, {
		executorId,
		projectPath: agent.projectPath || chat.projectPath,
	});
	const notice = resolveComposerAvailabilityNotice({
		executorId,
		executors: input.executors,
		projectTarget: target,
		projectResolution: target ? projects.snapshotFor(target) : { kind: 'unchecked' },
		catalog: executorCatalog,
		providerAvailable: isCustomProviderSelectionAvailable(executorCatalog, agent),
	});
	if (!notice) return null;
	const chooseProject = input.onChooseProjectFolder;
	return {
		chatId: chat.id,
		notice,
		onRetryProject() {
			const current = input.chat;
			if (!target || !input.visible || current?.id !== chat.id || agent.executorId !== executorId)
				return;
			const currentTarget = composerProjectTarget(current, {
				executorId,
				projectPath: agent.projectPath || current.projectPath,
			});
			if (!currentTarget || projectTargetKey(currentTarget) !== projectTargetKey(target)) return;
			const lease = projects.retain(target);
			void lease.retry().finally(() => lease.release());
		},
		onChooseProjectFolder: chooseProject &&
			(chat.status === 'draft' || executorCatalog.supportsUpdateProjectPath(chat.agentId))
			? () => chooseProject(chat.id)
			: undefined,
		onRetryCatalog: () => void executorCatalog.forceRefresh(),
	};
}

// Reports only the outermost obstacle: later checks depend on a reachable executor
// and project, and loading states are explained by the disabled send button.
export function resolveComposerAvailabilityNotice(
	input: ComposerAvailabilityInput,
): ComposerAvailabilityNotice | null {
	const { executorId, executors, projectTarget, projectResolution, catalog } = input;
	const executorNotice = resolveExecutorAvailabilityNotice(executors, executorId);
	if (executorNotice) return executorNotice;
	if (projectTarget && projectResolution.kind === 'unavailable') {
		return {
			kind: 'project-unavailable',
			projectPath: projectTarget.projectPath,
			reason: projectResolution.reason,
		};
	}
	if (projectTarget && projectResolution.kind === 'request-failed') {
		return {
			kind: 'project-unavailable',
			projectPath: projectTarget.projectPath,
			requestError: projectResolution.message,
		};
	}
	if (catalog.error) return { kind: 'catalog-failed', message: catalog.error };
	if (catalog.isValidated && !input.providerAvailable) return { kind: 'provider-unavailable' };
	return null;
}
