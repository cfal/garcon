import type { ProjectTarget, ProjectUnavailableReason } from '$shared/project-resolution';
import type { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte.js';
import type { ExecutorsStore } from '$lib/executors/executors-store.svelte.js';
import type { ProjectResolutionSnapshot } from '$lib/workspace/project-resolution-store.svelte.js';

export type ComposerAvailabilityNotice =
	| { readonly kind: 'executor-removed'; readonly executorId: string }
	| { readonly kind: 'executor-unavailable'; readonly executorLabel: string }
	| {
			readonly kind: 'project-unavailable';
			readonly projectPath: string;
			readonly reason?: ProjectUnavailableReason;
			readonly requestError?: string;
	  }
	| { readonly kind: 'catalog-failed'; readonly message: string }
	| { readonly kind: 'provider-unavailable' };

export interface ComposerAvailabilityInput {
	readonly executorId: string;
	readonly executors: Pick<ExecutorsStore, 'isReady' | 'hasSnapshot' | 'get' | 'label'>;
	readonly projectTarget: ProjectTarget | null;
	readonly projectResolution: ProjectResolutionSnapshot;
	readonly catalog: Pick<ModelCatalogStore, 'isValidated' | 'error'>;
	readonly providerAvailable: boolean;
}

// Reports only the outermost obstacle: later checks depend on a reachable executor
// and project, and loading states are explained by the disabled send button.
export function resolveComposerAvailabilityNotice(
	input: ComposerAvailabilityInput,
): ComposerAvailabilityNotice | null {
	const { executorId, executors, projectTarget, projectResolution, catalog } = input;
	if (!executors.isReady(executorId)) {
		return executors.hasSnapshot && !executors.get(executorId)
			? { kind: 'executor-removed', executorId }
			: { kind: 'executor-unavailable', executorLabel: executors.label(executorId) };
	}
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
