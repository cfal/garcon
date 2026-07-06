import type { SessionAgentId } from '$lib/types/app';
import type { ModelCatalogStore } from '$lib/stores/model-catalog.svelte';
import { buildModelSources } from './model-selector-options';
import type { ModelSelectorMode } from './model-selector-types';

// Resolves the model-selector configuration for the active chat composer.
// Existing chats expand to agent/source selection so a conversation can move
// between configured agents and providers, and collapse back to the compact
// single-model trigger when only one agent and one source are available.
export function composerModelSelectorMode(
	modelCatalog: ModelCatalogStore,
	agentId: SessionAgentId,
): ModelSelectorMode {
	const canSelectAgent = modelCatalog.getSelectableAgents().length > 1;
	// Different agents can expose different sources, so keep source selection
	// available whenever the agent can change. Otherwise only offer it when the
	// current agent genuinely has more than one source to choose between.
	const canSelectSource =
		canSelectAgent || buildModelSources(modelCatalog, agentId).length > 1;
	return {
		agent: canSelectAgent ? 'select' : 'fixed',
		source: canSelectSource ? 'select' : 'hidden',
		surface: 'composer',
	};
}
